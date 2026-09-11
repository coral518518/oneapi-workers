/**
 * NoteGPT 官方免签协议客户端（从 freeaiapi.py 转换而来）
 * 支持服务端动态凭据签发、SSE 流式解析以及额度耗尽自动更换 UUID 无限续杯
 */

export const DEFAULT_ANONYMOUS_USER_ID = "6684840a-964a-4698-b969-e9e147f02ad2";

export const QUOTA_EXHAUSTED_KEYWORDS = [
    "quota", "limit", "额度", "用完", "耗尽", "次数", "exceed",
    "insufficient", "upgrade", "reach", "premium", "not enough"
];

const NOTEGPT_HEADERS: Record<string, string> = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "origin": "https://notegpt.io",
    "referer": "https://notegpt.io/ai-agent",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};

export function extractTextFromContent(content: any): string {
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && typeof part.text === "string") {
                    return part.text;
                }
                return "";
            })
            .join("");
    }
    return "";
}

export function buildPromptFromOpenAIMessages(
    messages?: Array<{ role?: string; content?: any }>,
    prompt?: string
): string {
    if (prompt && typeof prompt === "string" && (!messages || messages.length === 0)) {
        return prompt;
    }
    if (!messages || messages.length === 0) {
        return prompt || "";
    }

    if (messages.length === 1 && messages[0].role === "user") {
        return extractTextFromContent(messages[0].content);
    }

    const parts: string[] = [];
    for (const msg of messages) {
        const text = extractTextFromContent(msg?.content);
        if (!text) continue;
        const role = msg?.role || "user";
        if (role === "system") {
            parts.push(`系统指令: ${text}`);
        } else if (role === "user") {
            parts.push(`用户: ${text}`);
        } else if (role === "assistant") {
            parts.push(`AI: ${text}`);
        } else {
            parts.push(`${role}: ${text}`);
        }
    }

    if (parts.length > 0 && messages[messages.length - 1].role === "user") {
        parts.push("AI:");
    }

    return parts.join("\n\n");
}

export interface NoteGPTConfig {
    t: number | string;
    nonce: string;
    sign: string;
    secret_key: string;
    app_id: string;
    uid: string;
    [key: string]: any;
}

export class NoteGPTClient {
    static BASE_URL = "https://notegpt.io";

    anonymousUserId: string;
    private cachedConfig: NoteGPTConfig | null = null;
    private configExpireTime = 0;

    constructor(anonymousUserId?: string) {
        this.anonymousUserId = anonymousUserId || crypto.randomUUID();
    }

    /**
     * 重置匿名用户身份 ID，清空服务端凭据缓存
     */
    resetUser(newUserId?: string): string {
        this.anonymousUserId = newUserId || crypto.randomUUID();
        this.cachedConfig = null;
        this.configExpireTime = 0;
        return this.anonymousUserId;
    }

    /**
     * 查询当前账号剩余免费额度
     */
    async getQuota(): Promise<any> {
        const url = `${NoteGPTClient.BASE_URL}/api/v2/user/quota?features=ai_chat`;
        const resp = await fetch(url, {
            method: "GET",
            headers: {
                ...NOTEGPT_HEADERS,
                "accept": "application/json, text/plain, */*",
                "cookie": `anonymous_user_id=${this.anonymousUserId}`,
            },
        });
        try {
            return await resp.json();
        } catch {
            return { status: resp.status, raw: await resp.text() };
        }
    }

    /**
     * 获取当前用户剩余的基础免费对话次数
     */
    async getRemainingQuota(): Promise<number> {
        try {
            const res = await this.getQuota();
            if (res?.code === 100000) {
                return res?.data?.ai_chat?.basic_quota?.remaining ?? 0;
            }
        } catch {
            // 忽略网络或解析错误
        }
        return 0;
    }

    /**
     * 获取官方服务端下发的有效会话凭据（动态 t、nonce、sign、secret_key 等）
     */
    async getValidConfig(forceRefresh = false): Promise<NoteGPTConfig> {
        const now = Date.now() / 1000;
        if (!forceRefresh && this.cachedConfig && now < this.configExpireTime) {
            return this.cachedConfig;
        }

        const url = `${NoteGPTClient.BASE_URL}/api/v1/ai-tab/get-prod-config`;
        const resp = await fetch(url, {
            method: "GET",
            headers: {
                ...NOTEGPT_HEADERS,
                "cookie": `anonymous_user_id=${this.anonymousUserId}`,
            },
        });

        if (!resp.ok) {
            throw new Error(`获取官方凭据 HTTP 错误: ${resp.status}`);
        }

        const data: any = await resp.json();
        if (data?.code === 100000 && data?.data) {
            this.cachedConfig = data.data as NoteGPTConfig;
            // 凭据通常有效期为几分钟，缓存 60 秒
            this.configExpireTime = now + 60;
            return this.cachedConfig;
        }

        throw new Error(`获取官方凭据失败: ${JSON.stringify(data)}`);
    }

    /**
     * 判断响应是否代表额度耗尽
     */
    isQuotaExhausted(responseData: any): boolean {
        const text = typeof responseData === "object"
            ? JSON.stringify(responseData)
            : String(responseData || "");
        const textLower = text.toLowerCase();
        return QUOTA_EXHAUSTED_KEYWORDS.some(kw => textLower.includes(kw));
    }

    /**
     * 发起 SSE 流式对话请求
     * - 自动获取服务端签名
     * - 自动检测额度耗尽并自动换号重试
     * - 实时 yield 返回文字片段
     */
    async *chatStream(
        promptText: string,
        model?: string,
        maxRetries = 3,
        signal?: AbortSignal
    ): AsyncGenerator<string, void, unknown> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            let configData: NoteGPTConfig;
            try {
                configData = await this.getValidConfig(attempt > 1);
            } catch (err) {
                console.warn(`[NoteGPT] 获取凭证失败，重置用户重试 (${attempt}/${maxRetries}):`, err);
                this.resetUser();
                continue;
            }

            const queryParams = new URLSearchParams();
            for (const [k, v] of Object.entries(configData)) {
                if (v !== undefined && v !== null) {
                    queryParams.set(k, String(v));
                }
            }

            const url = `${NoteGPTClient.BASE_URL}/api/v2/llm/question?${queryParams.toString()}`;
            const payload = {
                text: promptText,
                end_flag: true,
                streaming: true,
                model: model || "gemini-3.1-flash-lite",
            };

            let resp: Response;
            try {
                resp = await fetch(url, {
                    method: "POST",
                    headers: {
                        ...NOTEGPT_HEADERS,
                        "content-type": "application/json",
                        "cookie": `anonymous_user_id=${this.anonymousUserId}`,
                    },
                    body: JSON.stringify(payload),
                    signal,
                });
            } catch (reqErr: any) {
                if (signal?.aborted) return;
                console.error(`[NoteGPT] 网络请求失败:`, reqErr);
                if (attempt < maxRetries) {
                    this.resetUser();
                    continue;
                }
                throw new Error(`[NoteGPT 网络请求失败]: ${reqErr?.message || reqErr}`);
            }

            // A. 状态码异常处理 (429/403)
            if (resp.status === 429 || resp.status === 403) {
                console.warn(`[NoteGPT] 触发限流/限制 (HTTP ${resp.status})，自动换号重试 (${attempt}/${maxRetries})...`);
                this.resetUser();
                continue;
            }

            // B. 接口直接返回 JSON 异常处理
            const contentType = resp.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
                try {
                    const errJson: any = await resp.json();
                    if (this.isQuotaExhausted(errJson) || [164001, 164003, 164005].includes(errJson?.code)) {
                        console.warn(`[NoteGPT] 提示额度不足或凭据过期，自动换号重试 (${attempt}/${maxRetries})...`);
                        this.resetUser();
                        continue;
                    }
                    throw new Error(`[NoteGPT 接口返回错误]: ${JSON.stringify(errJson)}`);
                } catch (e: any) {
                    if (attempt < maxRetries) {
                        this.resetUser();
                        continue;
                    }
                    throw e;
                }
            }

            if (!resp.ok || !resp.body) {
                if (attempt < maxRetries) {
                    this.resetUser();
                    continue;
                }
                const errText = await resp.text().catch(() => "");
                throw new Error(`[NoteGPT HTTP 异常 ${resp.status}]: ${errText}`);
            }

            // C. 正常读取并解析 SSE 数据流
            const reader = resp.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let quotaExhaustedInStream = false;
            let piecesCount = 0;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const rawLine of lines) {
                        const line = rawLine.trim();
                        if (!line || line.startsWith("id:") || line.startsWith("event:")) {
                            continue;
                        }

                        if (!line.startsWith("data:")) {
                            continue;
                        }

                        const raw = line.slice(5).trim();
                        if (!raw || raw === "[DONE]") {
                            break;
                        }

                        try {
                            const eventData = JSON.parse(raw);
                            if (typeof eventData === "object" && eventData !== null) {
                                if (this.isQuotaExhausted(eventData)) {
                                    quotaExhaustedInStream = true;
                                    break;
                                }

                                const piece = eventData.message || eventData.text || "";
                                if (piece) {
                                    piecesCount++;
                                    yield piece;
                                }
                            } else if (typeof eventData === "string") {
                                piecesCount++;
                                yield eventData;
                            }
                        } catch {
                            // 忽略单个 JSON 解析异常
                        }
                    }

                    if (quotaExhaustedInStream) {
                        break;
                    }
                }
            } finally {
                try {
                    await reader.cancel();
                } catch {
                    // 忽略释放 reader 的异常
                }
            }

            if (quotaExhaustedInStream) {
                console.warn(`[NoteGPT] 数据流中检测到额度耗尽，自动换号重试 (${attempt}/${maxRetries})...`);
                this.resetUser();
                continue;
            }

            if (piecesCount > 0) {
                return;
            }

            // 如果没有任何输出且未完成，换号重试
            this.resetUser();
        }

        throw new Error(`[NoteGPT 错误]: 连续重试 ${maxRetries} 次仍未成功`);
    }

    /**
     * 非流式调用，聚合所有回答文本并返回完整内容
     */
    async chat(
        promptText: string,
        model?: string,
        maxRetries = 3,
        signal?: AbortSignal
    ): Promise<string> {
        const chunks: string[] = [];
        for await (const piece of this.chatStream(promptText, model, maxRetries, signal)) {
            chunks.push(piece);
        }
        return chunks.join("");
    }
}

// 共享的默认全局客户端实例（在 Workers 生命周期中保持 UUID 与凭证缓存，额度用尽时自动刷新）
export const defaultNoteGPTClient = new NoteGPTClient(DEFAULT_ANONYMOUS_USER_ID);

