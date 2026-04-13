type Variables = {
    lang: string | undefined | null
}

type CloudflareBindings = {
    DB: D1Database;
    ASSETS: Fetcher;
    ADMIN_TOKEN: string;
}

type HonoCustomType = {
    "Bindings": CloudflareBindings;
    "Variables": Variables;
}

// 数据库表行的基础结构
type BaseDbRow = {
    created_at: string;
    updated_at: string;
}

// channel_config 表的行结构
type ChannelConfigRow = BaseDbRow & {
    key: string;
    value: string; // JSON 字符串，解析后为 ChannelConfig 类型
}

// api_token 表的行结构
type ApiTokenRow = BaseDbRow & {
    key: string;
    value: string; // JSON 字符串，解析后为 ApiTokenData 类型
    usage: number;
}

type ChannelType =
    | "azure-openai"
    | "openai"
    | "claude"
    | "claude-to-openai"
    | "openai-responses"
    | "azure-openai-responses"
    | undefined
    | null;

type ChannelConfig = {
    name: string;
    type: ChannelType;
    endpoint: string;
    api_key: string;
    api_version?: string;
    deployment_mapper: Record<string, string>;
    model_pricing?: Record<string, ModelPricing>;
    priority?: number; // 同模型内多提供商的优先级，越大越优先，默认 0
}

type ChannelConfigMap = {
    [key: string]: ChannelConfig;
}

type OpenAIResponse = {
    usage?: Usage
}

type Usage = {
    prompt_tokens?: number,
    completion_tokens?: number,
    total_tokens?: number,
    cached_tokens?: number,
}

type CommonResponse = {
    success?: boolean;
    message?: string;
    data?: any;
}

type ModelPricing = {
    input: number;
    output: number;
    cache?: number;
}

type ApiTokenData = {
    name: string;
    channel_keys: string[];
    total_quota: number;
}

/**
 * 故障切换配置
 *
 * chains 示例：[["gpt-5.4", "gpt-5.2", "gpt-5.1"], ["claude-opus-4", "claude-sonnet-4"]]
 * 当用户请求 gpt-5.4 时：
 *   1. 先对所有 gpt-5.4 提供商随机重试（最多 max_retries_per_model 次）
 *   2. 全部失败后降级到 gpt-5.2，再重试
 *   3. 再失败降级到 gpt-5.1
 */
type FailoverConfig = {
    enabled: boolean;
    max_retries_per_model: number; // 每个模型级别的最大尝试次数（含首次），默认 3
    chains: string[][];            // 有序模型降级链，每条链内按优先级从高到低排列
}
