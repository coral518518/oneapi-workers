import { Context } from "hono";

import { CONSTANTS } from "../constants";
import utils from "../utils";

// 内存缓存全局定价，避免每次请求都读取 D1 数据库
let cachedGlobalPricing: Record<string, ModelPricing> | null = null;
let cachedGlobalPricingTime = 0;
const PRICING_CACHE_TTL_MS = 60 * 1000; // 缓存 60 秒

// Token 工具对象
export const TokenUtils = {
    /**
     * 清除全局定价内存缓存（在管理员更新定价后调用）
     */
    clearPricingCache(): void {
        cachedGlobalPricing = null;
        cachedGlobalPricingTime = 0;
    },

    /**
     * 更新令牌的使用额度
     */
    async updateUsage(c: Context<HonoCustomType>, key: string, usageAmount: number): Promise<boolean> {
        if (usageAmount <= 0) {
            return true; // 无消耗时无需写入数据库
        }
        try {
            const result = await c.env.DB.prepare(
                `UPDATE api_token SET usage = usage + ?, updated_at = datetime('now') WHERE key = ?`
            ).bind(usageAmount, key).run();

            return result.success;
        } catch (error) {
            console.error('Error updating token usage:', error);
            return false;
        }
    },

    /**
     * 获取指定模型的定价规则
     * 查找优先级：
     * 1. 渠道自定义定价（优先匹配用户请求原始模型，后匹配底层部署模型）
     * 2. 全局模型定价（优先匹配用户请求原始模型，后匹配底层部署模型）
     */
    async getPricing(
        c: Context<HonoCustomType>,
        originalModel: string,
        deploymentModel?: string,
        channelConfig?: ChannelConfig
    ): Promise<ModelPricing | null> {
        // 1. 检查渠道私有定价
        if (channelConfig?.model_pricing) {
            if (channelConfig.model_pricing[originalModel]) {
                return channelConfig.model_pricing[originalModel];
            }
            if (deploymentModel && channelConfig.model_pricing[deploymentModel]) {
                return channelConfig.model_pricing[deploymentModel];
            }
        }

        // 2. 检查全局定价（带内存缓存，大幅减少 D1 数据库读压力）
        const now = Date.now();
        if (!cachedGlobalPricing || (now - cachedGlobalPricingTime > PRICING_CACHE_TTL_MS)) {
            cachedGlobalPricing = await utils.getJsonSetting<Record<string, ModelPricing>>(c, CONSTANTS.MODEL_PRICING_KEY);
            cachedGlobalPricingTime = now;
        }

        if (cachedGlobalPricing) {
            if (cachedGlobalPricing[originalModel]) {
                return cachedGlobalPricing[originalModel];
            }
            if (deploymentModel && cachedGlobalPricing[deploymentModel]) {
                return cachedGlobalPricing[deploymentModel];
            }
        }

        return null;
    },

    /**
     * 判断模型是否为不计费模型（未配置定价，或输入/输出费用均为 0）
     */
    async isFreeModel(
        c: Context<HonoCustomType>,
        originalModel: string,
        deploymentModel?: string,
        channelConfig?: ChannelConfig
    ): Promise<boolean> {
        const pricing = await this.getPricing(c, originalModel, deploymentModel, channelConfig);
        if (!pricing) {
            return true; // 未配置定价 -> 不计费模型
        }
        const hasCost = (pricing.input && pricing.input > 0) ||
            (pricing.output && pricing.output > 0) ||
            (pricing.cache && pricing.cache > 0);
        return !hasCost;
    },

    /**
     * 结算并扣减使用配额
     * 如果未配置定价或属于免费模型，直接完全跳过后续所有价格计算与数据库操作
     */
    async processUsage(
        c: Context<HonoCustomType>,
        apiKey: string,
        originalModel: string,
        deploymentModel: string,
        targetChannelKey: string,
        targetChannelConfig: ChannelConfig,
        usage: Usage
    ): Promise<void> {
        // 1. 获取定价规则：若未配置定价（不计费），直接跳过后续计算与数据库写入
        const pricing = await this.getPricing(c, originalModel, deploymentModel, targetChannelConfig);
        if (!pricing) {
            // 模型没有配置定价，直接判定为免费/不计费，跳过后续全部逻辑
            return;
        }

        const isFree = (pricing.input <= 0) &&
            (pricing.output <= 0) &&
            (!pricing.cache || pricing.cache <= 0);

        if (isFree) {
            return;
        }

        // 2. 检查是否有有效的 Token 数据
        const hasTokens = usage.prompt_tokens != null && usage.completion_tokens != null;
        if (!hasTokens) {
            return;
        }

        const inputCost = (usage.prompt_tokens || 0) * (pricing.input || 0);
        const outputCost = (usage.completion_tokens || 0) * (pricing.output || 0);

        let cacheCost = 0;
        if (usage.cached_tokens && usage.cached_tokens > 0 && pricing.cache) {
            cacheCost = usage.cached_tokens * pricing.cache;
        }

        const totalCost = Math.round(inputCost + outputCost + cacheCost);
        if (totalCost <= 0) {
            return;
        }

        await this.updateUsage(c, apiKey, totalCost);

        const maskedApiKey = apiKey.length < 6 ? '***' : (
            apiKey.slice(0, 3)
            + '***'
            + apiKey.slice(-3)
        );
        console.log(`[Usage] Model: ${originalModel}${deploymentModel !== originalModel ? ` (${deploymentModel})` : ''}, Channel: ${targetChannelKey}, Key: ${maskedApiKey}, Cost: ${totalCost} (input: ${inputCost}, cache: ${cacheCost}, output: ${outputCost})`);
    }
};

