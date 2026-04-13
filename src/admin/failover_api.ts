import { Context } from "hono"
import { contentJson, OpenAPIRoute } from 'chanfana';
import { z } from 'zod';

import { CommonErrorResponse, CommonSuccessfulResponse } from "../model";
import utils from "../utils";

const FAILOVER_CONFIG_KEY = "failover_config";

const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
    enabled: false,
    max_retries_per_model: 3,
    chains: [],
};

// 获取 Failover 配置
export class FailoverGetEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['Admin API'],
        summary: 'Get failover configuration',
        responses: {
            ...CommonSuccessfulResponse(z.object({
                enabled: z.boolean().describe('Whether failover is enabled'),
                max_retries_per_model: z.number().describe('Max retry attempts per model tier'),
                chains: z.array(z.array(z.string())).describe('Ordered model fallback chains'),
            })),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const raw = await utils.getJsonSetting<any>(c, FAILOVER_CONFIG_KEY);

        // 兼容旧格式 { enabled, max_retries }
        const config: FailoverConfig = {
            enabled: raw?.enabled ?? DEFAULT_FAILOVER_CONFIG.enabled,
            max_retries_per_model: raw?.max_retries_per_model ?? raw?.max_retries ?? DEFAULT_FAILOVER_CONFIG.max_retries_per_model,
            chains: Array.isArray(raw?.chains) ? raw.chains : DEFAULT_FAILOVER_CONFIG.chains,
        };

        return {
            success: true,
            data: config,
        } as CommonResponse;
    }
}

// 保存 Failover 配置
export class FailoverUpdateEndpoint extends OpenAPIRoute {
    schema = {
        tags: ['Admin API'],
        summary: 'Update failover configuration',
        request: {
            body: contentJson({
                schema: z.object({
                    enabled: z.boolean().describe('Whether failover is enabled'),
                    max_retries_per_model: z.number().min(1).max(20).describe('Max retry attempts per model tier (1-20)'),
                    chains: z.array(z.array(z.string())).describe('Ordered model fallback chains'),
                }),
            }),
        },
        responses: {
            ...CommonSuccessfulResponse(z.boolean()),
            ...CommonErrorResponse,
        },
    };

    async handle(c: Context<HonoCustomType>) {
        const body = await c.req.json<FailoverConfig>();

        const config: FailoverConfig = {
            enabled: !!body.enabled,
            max_retries_per_model: Math.max(1, Math.min(20, Number(body.max_retries_per_model) || 3)),
            chains: Array.isArray(body.chains)
                ? body.chains.filter(chain => Array.isArray(chain) && chain.length > 0)
                : [],
        };

        await utils.saveSetting(c, FAILOVER_CONFIG_KEY, JSON.stringify(config));

        return {
            success: true,
            data: true,
        } as CommonResponse;
    }
}
