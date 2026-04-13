import { Context, Hono } from "hono"
import { contentJson, fromHono, OpenAPIRoute } from 'chanfana';

import azureOpenaiProxy from "./azure-openai-proxy"
import openaiProxy from "./openai-proxy"
import claudeProxy from "./claude-proxy"
import claudeToOpenaiProxy from "./claude-to-openai-proxy"
import openaiResponsesProxy from "./openai-responses-proxy"
import azureOpenaiResponsesProxy from "./azure-openai-responses-proxy"
import utils, { findDeploymentMapping } from "../utils"
import { TokenUtils } from "../admin/token_utils"
import { CONSTANTS } from "../constants"
import { z } from "zod";

export const api = fromHono(new Hono<HonoCustomType>())

const providerMap: Record<
    string,
    (
        c: Context<HonoCustomType>,
        config: ChannelConfig,
        requestBody: any,
        saveUsage: (usage: Usage) => Promise<void>
    ) => Promise<Response>
> = {
    "azure-openai": azureOpenaiProxy.fetch,
    "openai": openaiProxy.fetch,
    "claude": claudeProxy.fetch,
    "claude-to-openai": claudeToOpenaiProxy.fetch,
    "openai-responses": openaiResponsesProxy.fetch,
    "azure-openai-responses": azureOpenaiResponsesProxy.fetch,
};

const getApiKeyFromHeaders = (c: Context<HonoCustomType>): string | null => {
    const authHeader = c.req.raw.headers.get('Authorization');
    const xApiKey = c.req.raw.headers.get('x-api-key');

    if (authHeader) {
        return authHeader.replace("Bearer ", "").trim();
    }
    if (xApiKey) {
        return xApiKey.trim();
    }
    return null;
}

const fetchTokenData = async (c: Context<HonoCustomType>, apiKey: string) => {
    const tokenResult = await c.env.DB.prepare(
        `SELECT * FROM api_token WHERE key = ?`
    ).bind(apiKey).first();

    if (!tokenResult || !tokenResult.value) {
        return null;
    }

    return {
        tokenData: JSON.parse(tokenResult.value as string) as ApiTokenData,
        usage: tokenResult.usage as number || 0,
    };
}

const fetchChannelsForToken = async (
    c: Context<HonoCustomType>,
    tokenData: ApiTokenData
) => {
    const channelKeys = tokenData.channel_keys;

    if (!channelKeys || channelKeys.length === 0) {
        return await c.env.DB.prepare(
            `SELECT key, value FROM channel_config`
        ).all<ChannelConfigRow>();
    }

    const channelQuery = channelKeys.map(() => '?').join(',');
    return await c.env.DB.prepare(
        `SELECT key, value FROM channel_config WHERE key IN (${channelQuery})`
    ).bind(...channelKeys).all<ChannelConfigRow>();
}

/**
 * 判断 HTTP 状态码是否触发故障切换
 * - 5xx 服务端错误 -> 切换
 * - 429 限流      -> 切换
 * - 其他 4xx/2xx  -> 不切换（视为正常业务响应）
 */
const shouldFailover = (status: number): boolean => {
    return status === 429 || (status >= 500 && status < 600);
}

type ParsedChannel = {
    key: string;
    config: ChannelConfig;
}

type AvailableChannel = {
    key: string;
    config: ChannelConfig;
    mapping: { pattern: string; deployment: string };
}

/**
 * 核心故障切换代理逻辑
 *
 * 行为说明：
 * 1. 根据 originalModel 在 chains 中找到所属降级链，构建 modelSequence
 *    例：originalModel="gpt-5.4"，chain=["gpt-5.4","gpt-5.2","gpt-5.1"]
 *    => modelSequence = ["gpt-5.4", "gpt-5.2", "gpt-5.1"]
 *
 * 2. 对 modelSequence 中每个模型：
 *    a. 找出支持该模型的所有 channel
 *    b. 按 channel.priority 降序排列（相同 priority 随机打乱，实现负载均衡）
 *    c. 依次尝试，最多 max_retries_per_model 次
 *    d. 某次返回成功或不可重试的 4xx -> 直接返回
 *    e. 5xx / 429 / 网络异常 -> 尝试同模型下一个 channel
 *    f. 该模型所有 channel 全部失败 -> 降级到下一个模型
 *
 * 3. 所有模型均失败 -> 返回最后一个错误响应
 */
const proxyWithFailover = async (
    c: Context<HonoCustomType>,
    allChannelRows: ChannelConfigRow[],
    originalModel: string,
    requestBody: any,
    apiKey: string,
    failoverConfig: FailoverConfig | null,
    allowedTypes?: ChannelType[]
): Promise<Response> => {
    const failoverEnabled = failoverConfig?.enabled ?? false;
    const maxRetriesPerModel = Math.max(1, failoverConfig?.max_retries_per_model ?? 3);

    // 预解析所有 channel 配置，避免在循环中重复 JSON.parse
    const parsedChannels: ParsedChannel[] = allChannelRows.map(row => ({
        key: row.key,
        config: JSON.parse(row.value) as ChannelConfig,
    }));

    // 找出支持指定模型的所有 channel（可选：只允许特定类型）
    const findChannelsForModel = (model: string): AvailableChannel[] => {
        const result: AvailableChannel[] = [];
        for (const { key, config } of parsedChannels) {
            if (allowedTypes && (!config.type || !allowedTypes.includes(config.type))) {
                continue;
            }
            const mapping = findDeploymentMapping(config.deployment_mapper, model);
            if (mapping) {
                result.push({ key, config, mapping });
            }
        }
        return result;
    };

    // 按照 priority 降序 + 同优先级随机打乱
    const prioritizeChannels = (channels: AvailableChannel[]): AvailableChannel[] => {
        const shuffled = [...channels].sort(() => Math.random() - 0.5);
        return shuffled.sort((a, b) => (b.config.priority ?? 0) - (a.config.priority ?? 0));
    };

    // 根据 originalModel 在 chains 中找到降级链，构建 modelSequence
    const buildModelSequence = (): string[] => {
        if (!failoverEnabled || !failoverConfig?.chains?.length) {
            return [originalModel];
        }
        for (const chain of failoverConfig.chains) {
            const idx = chain.indexOf(originalModel);
            if (idx >= 0) {
                return chain.slice(idx); // 从当前模型开始到链尾
            }
        }
        // 不在任何链中：只用原始模型
        return [originalModel];
    };

    // ------------------------------------------------------------------
    // 故障切换关闭：保持原有行为（随机选一个 channel，不重试，不降级）
    // ------------------------------------------------------------------
    if (!failoverEnabled) {
        const channels = findChannelsForModel(originalModel);
        if (channels.length === 0) {
            return new Response(`No channels available for model: ${originalModel}`, { status: 400 });
        }
        const selected = channels[Math.floor(Math.random() * channels.length)];
        const proxyFetch = providerMap[selected.config.type || ""];
        if (!proxyFetch) {
            return new Response("Channel type not supported", { status: 400 });
        }
        const body = { ...requestBody, model: selected.mapping.deployment };
        return proxyFetch(c, selected.config, body,
            async (usage: Usage) => {
                try {
                    await TokenUtils.processUsage(c, apiKey, body.model, selected.key, selected.config, usage);
                } catch (error) {
                    console.error('Error processing usage:', error);
                }
            }
        );
    }

    // ------------------------------------------------------------------
    // 故障切换开启：按模型序列逐级尝试
    // ------------------------------------------------------------------
    const modelSequence = buildModelSequence();
    let lastResponse: Response | null = null;
    let lastError: Error | null = null;

    for (let mi = 0; mi < modelSequence.length; mi++) {
        const currentModel = modelSequence[mi];
        const modelChannels = findChannelsForModel(currentModel);

        if (modelChannels.length === 0) {
            console.warn(`[Failover] No channels for model "${currentModel}", skipping.`);
            continue;
        }

        const prioritized = prioritizeChannels(modelChannels);
        const attempts = Math.min(maxRetriesPerModel, prioritized.length);

        if (currentModel !== originalModel) {
            console.log(`[Failover] Degrading to model "${currentModel}" (${prioritized.length} channel(s) available)`);
        }

        for (let i = 0; i < attempts; i++) {
            const selected = prioritized[i];
            const proxyFetch = providerMap[selected.config.type || ""];
            if (!proxyFetch) {
                console.warn(`[Failover] Channel "${selected.key}" type "${selected.config.type}" not supported, skipping.`);
                continue;
            }

            const body = { ...requestBody, model: selected.mapping.deployment };

            try {
                const response = await proxyFetch(c, selected.config, body,
                    async (usage: Usage) => {
                        try {
                            await TokenUtils.processUsage(c, apiKey, body.model, selected.key, selected.config, usage);
                        } catch (error) {
                            console.error('Error processing usage:', error);
                        }
                    }
                );

                if (!shouldFailover(response.status)) {
                    // 成功或不可重试错误（4xx 非 429）
                    if (currentModel !== originalModel) {
                        console.log(`[Failover] OK with fallback model="${currentModel}" channel="${selected.key}"`);
                    } else if (i > 0) {
                        console.log(`[Failover] OK with model="${currentModel}" channel="${selected.key}" (attempt ${i + 1})`);
                    }
                    return response;
                }

                // 5xx / 429 -> 继续尝试该模型的下一个 channel
                console.warn(`[Failover] model="${currentModel}" channel="${selected.key}" -> ${response.status} (attempt ${i + 1}/${attempts})`);
                lastResponse = response;

            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[Failover] model="${currentModel}" channel="${selected.key}" -> error: ${errMsg} (attempt ${i + 1}/${attempts})`);
                lastError = err instanceof Error ? err : new Error(errMsg);
            }
        }

        // 该模型下所有 channel 均失败，尝试降级
        if (mi < modelSequence.length - 1) {
            console.warn(`[Failover] All channels for model "${currentModel}" exhausted, falling back to "${modelSequence[mi + 1]}"...`);
        }
    }

    // 所有模型均失败
    if (lastResponse) return lastResponse;
    if (lastError) throw lastError;
    return new Response("All channels and fallback models failed", { status: 502 });
}

class ProxyEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['OpenAI Proxy'],
        request: {
            headers: z.object({
                'Authorization': z.string().optional().describe("Token for authentication (OpenAI format)"),
                'x-api-key': z.string().optional().describe("API key for authentication (Claude format)"),
            }),
            body: contentJson({
                schema: z.any(),
            }),
        },
        responses: {
            200: {
                description: 'Successful response',
            },
        },
    };

    async handle(c: Context<HonoCustomType>) {
        // Support both OpenAI format (Authorization: Bearer xxx) and Claude format (x-api-key: xxx)
        const apiKey = getApiKeyFromHeaders(c);
        if (!apiKey) {
            return c.text("Authorization header or x-api-key not found", 401);
        }

        const tokenInfo = await fetchTokenData(c, apiKey);
        if (!tokenInfo) {
            return c.text("Invalid API key", 401);
        }

        const { tokenData, usage } = tokenInfo;

        // Check if token has sufficient quota
        if (usage >= tokenData.total_quota) {
            return c.text("Quota exceeded", 402);
        }

        // Get available channel configs based on token permissions
        const channelsResult = await fetchChannelsForToken(c, tokenData);

        if (!channelsResult.results || channelsResult.results.length === 0) {
            return c.text("No available channels for this token", 401);
        }

        let requestBody: any;
        try {
            requestBody = await c.req.json();
        } catch (error) {
            return c.text("Invalid JSON body", 400);
        }
        const model = requestBody.model;
        if (!model) {
            return c.text("Model is required", 400);
        }

        // 检查原始模型是否有任何 channel 支持（快速失败，避免不必要的配置读取）
        const allRows = channelsResult.results;
        const hasOriginalModel = allRows.some(row => {
            const config = JSON.parse(row.value) as ChannelConfig;
            return findDeploymentMapping(config.deployment_mapper, model) !== null;
        });

        if (!hasOriginalModel) {
            return c.text(`Model not mapped: ${model}. Please configure deployment_mapper.`, 400);
        }

        // 读取故障切换配置（不存在时为 null，proxyWithFailover 会使用默认值）
        const failoverConfig = await utils.getJsonSetting<FailoverConfig>(c, "failover_config");

        return proxyWithFailover(c, allRows, model, requestBody, apiKey, failoverConfig);
    }
}

api.post("/v1/chat/completions", ProxyEndpoint)
api.post("/v1/messages", ProxyEndpoint)  // Claude API endpoint

class ResponsesProxyEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['OpenAI Responses Proxy'],
        request: {
            headers: z.object({
                'Authorization': z.string().optional().describe("Token for authentication (OpenAI format)"),
                'x-api-key': z.string().optional().describe("API key for authentication (Claude format)"),
            }),
            body: contentJson({
                schema: z.any(),
            }),
        },
        responses: {
            200: {
                description: 'Successful response',
            },
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const apiKey = getApiKeyFromHeaders(c);
        if (!apiKey) {
            return c.text("Authorization header or x-api-key not found", 401);
        }

        const tokenInfo = await fetchTokenData(c, apiKey);
        if (!tokenInfo) {
            return c.text("Invalid API key", 401);
        }

        const { tokenData, usage } = tokenInfo;

        if (usage >= tokenData.total_quota) {
            return c.text("Quota exceeded", 402);
        }

        const channelsResult = await fetchChannelsForToken(c, tokenData);

        if (!channelsResult.results || channelsResult.results.length === 0) {
            return c.text("No available channels for this token", 401);
        }

        let requestBody: any;
        try {
            requestBody = await c.req.json();
        } catch (error) {
            return c.text("Invalid JSON body", 400);
        }
        const model = requestBody.model;
        if (!model) {
            return c.text("Model is required", 400);
        }

        const allowedTypes: ChannelType[] = ["openai-responses", "azure-openai-responses"];
        const allRows = channelsResult.results;

        // 检查原始模型（且类型合法）是否有 channel 支持
        const hasOriginalModel = allRows.some(row => {
            const config = JSON.parse(row.value) as ChannelConfig;
            if (!config.type || !allowedTypes.includes(config.type)) return false;
            return findDeploymentMapping(config.deployment_mapper, model) !== null;
        });

        if (!hasOriginalModel) {
            return c.text(`Model not mapped: ${model}. Please configure deployment_mapper.`, 400);
        }

        const failoverConfig = await utils.getJsonSetting<FailoverConfig>(c, "failover_config");

        return proxyWithFailover(c, allRows, model, requestBody, apiKey, failoverConfig, allowedTypes);
    }
}

api.post("/v1/responses", ResponsesProxyEndpoint)

// Models endpoint
import { ModelsEndpoint } from "./models"
api.get("/v1/models", ModelsEndpoint)
