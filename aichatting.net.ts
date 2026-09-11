/**
 * ================================================================================
 * AIChatting (aichatting.net) 免登录逆向协议客户端 (TypeScript 独立版)
 * ================================================================================
 *
 * 核心原理与免密/免登录逆向分析 (经前端 Next.js 核心分包反编译提取):
 * 1. 鉴权机制:
 *    - 服务端通过请求头中的 `vtoken` (Visitor Token) 识别访客身份。
 *    - `vtoken` 是前端通过 FingerprintJS 生成的 32 位 Hex 访客 ID (`visitorId`),
 *      并使用 1024 位 RSA 公钥通过 PKCS#1 v1.5 Padding 加密并 Base64 编码而成。
 *    - 核心公钥从前端模块 41789 中提取:
 *      MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCAdf/EyIbLBxjGqmh7qLU6/CPCzru+75+82OSPZ+nf4BFvg88drpZ6KigNW0J8TNgxe6Yms1irCZNVDyu+RXsl4y/7c2KOHc4OGTzHB5fUMiMasFUvcEs2P70e6yA/sKHZfBLG1XPhlb84Ibs3nhD3W5e2SuC+4EuVkaqzN08LQIDAQAB
 *
 * 2. 额度机制与无限续杯:
 *    - 每一个全新的 `visitorId` 拥有若干次免费提问额度。
 *    - 当额度耗尽时，服务端返回:
 *      {"message":"The free quota has been exhausted, please login!","code":-1,"data":null}
 *    - 客户端只需重新随机生成 32 位 Hex 并重新 RSA 加密得到新 `vtoken`，即可实现零成本无限换号续杯！
 *
 * 3. 流式文本解码规则:
 *    - 接口: POST https://aga-api.aichatting.net/aigc/chat/v2/professional/stream
 *    - 格式为标准 SSE (Server-Sent Events), 结束标志为 `data:--@DONE@--`
 *    - 为了绕过标准 SSE 对连续空格和换行的剥离，服务端将文本分片编码为:
 *      `-=- --` -> 空格 (' ')
 *      `-=-n--` -> 换行 ('\n')
 *    - 客户端在接收到流时对上述占位符进行还原，即可得到完整排版 Markdown。
 *
 * 4. 支持模型:
 *    - `gpt-5.6-luna`: 免费模型（默认，知识库截至 2024 年，响应极快）
 *    - `gpt-5.6-terra`: 会员专享模型
 * ================================================================================
 */

import { publicEncrypt, constants, randomBytes } from "node:crypto";
import * as readline from "node:readline";

/**
 * 官方写死在前端编译包中的 1024-bit RSA 公钥
 */
export const AICHATTING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCAdf/EyIbLBxjGqmh7qLU6/CP
Czru+75+82OSPZ+nf4BFvg88drpZ6KigNW0J8TNgxe6Yms1irCZNVDyu+RXsl4y/
7c2KOHc4OGTzHB5fUMiMasFUvcEs2P70e6yA/sKHZfBLG1XPhlb84Ibs3nhD3W5e
2SuC+4EuVkaqzN08LQIDAQAB
-----END PUBLIC KEY-----`;

export const AICHATTING_API_URL = "https://aga-api.aichatting.net/aigc/chat/v2/professional/stream";

export const DEFAULT_MODEL = "gpt-5.6-luna";

export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}

export interface AIChattingOptions {
    /** 初始访客ID (32位十六进制字符串)，不传则自动随机生成 */
    visitorId?: string;
    /** 额度耗尽时是否自动刷新访客ID并重试 (默认 true，实现无限续杯) */
    autoRotateOnExhaust?: boolean;
    /** 默认模型 (默认 "gpt-5.6-luna") */
    defaultModel?: string;
    /** 语言代码 (默认 "en") */
    lang?: string;
}

export interface ChatStreamOptions {
    /** 指定调用的模型 */
    model?: string;
    /** 角色 ID，普通对话传 0 */
    roleId?: number;
    /** 最大重试轮次 (换号重试) */
    maxRetries?: number;
    /** 请求超时时间 (毫秒，默认 60000) */
    timeout?: number;
    /** 中断控制器信号 */
    signal?: AbortSignal;
}

/**
 * 生成随机 32 位 Hex 字符串模拟真实浏览器设备指纹 (FingerprintJS)
 */
export function generateVisitorId(): string {
    return randomBytes(16).toString("hex");
}

/**
 * 使用 RSA 公钥与 PKCS#1 v1.5 Padding 对 visitorId 进行加密生成合法的 vtoken
 */
export function encryptVisitorId(visitorId: string): string {
    const buffer = Buffer.from(visitorId, "utf8");
    const encrypted = publicEncrypt(
        {
            key: AICHATTING_PUBLIC_KEY,
            padding: constants.RSA_PKCS1_PADDING,
        },
        buffer
    );
    return encrypted.toString("base64");
}

/**
 * 还原 SSE 流中的特殊编码分片
 * 还原空格与换行
 */
export function decodeStreamChunk(rawText: string): string {
    return rawText.replace(/-=- --/g, " ").replace(/-=-n--/g, "\n");
}

/**
 * 格式化多轮消息体为 aichatting 要求的载荷格式
 */
export function formatMessages(messages: ChatMessage[]): Array<{
    role: string;
    content: Array<{ type: "text"; text: string }>;
}> {
    return messages.map(msg => ({
        role: msg.role,
        content: [{ type: "text", text: msg.content }],
    }));
}

/**
 * AIChatting 客户端核心类
 */
export class AIChattingClient {
    public visitorId: string;
    public vtoken: string;
    public autoRotateOnExhaust: boolean;
    public defaultModel: string;
    public lang: string;
    public history: ChatMessage[] = [];

    constructor(options: AIChattingOptions = {}) {
        this.visitorId = options.visitorId || generateVisitorId();
        this.vtoken = encryptVisitorId(this.visitorId);
        this.autoRotateOnExhaust = options.autoRotateOnExhaust ?? true;
        this.defaultModel = options.defaultModel || DEFAULT_MODEL;
        this.lang = options.lang || "en";
    }

    /**
     * 重置访客身份 ID，生成全新 vtoken，实现额度恢复
     */
    public resetVisitor(newVisitorId?: string): string {
        this.visitorId = newVisitorId || generateVisitorId();
        this.vtoken = encryptVisitorId(this.visitorId);
        return this.visitorId;
    }

    /**
     * 清空上下文历史
     */
    public newChat(): void {
        this.history = [];
    }

    /**
     * 发起 SSE 流式对话请求
     * @param input 单条提问字符串，或者包含历史上下文的 ChatMessage 数组
     * @param options 对话配置
     */
    public async *chatStream(
        input: string | ChatMessage[],
        options: ChatStreamOptions = {}
    ): AsyncGenerator<string, void, unknown> {
        const model = options.model || this.defaultModel;
        const roleId = options.roleId ?? 0;
        const maxRetries = options.maxRetries ?? (this.autoRotateOnExhaust ? 3 : 1);
        const timeout = options.timeout ?? 60000;

        // 统一消息格式
        let currentMessages: ChatMessage[];
        let userQuestion = "";

        if (typeof input === "string") {
            userQuestion = input;
            currentMessages = [...this.history, { role: "user", content: input }];
        } else {
            currentMessages = input;
            const lastMsg = input[input.length - 1];
            if (lastMsg && lastMsg.role === "user") {
                userQuestion = lastMsg.content;
            }
        }

        const requestBodyPayload = {
            spaceHandle: true,
            roleId,
            messages: formatMessages(currentMessages),
            conversationId: Math.floor(Math.random() * 80000000) + 10000000,
            model,
        };

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(new Error("Request timeout")), timeout);

            // 合并外部 signal
            if (options.signal) {
                options.signal.addEventListener("abort", () => controller.abort());
            }

            try {
                const response = await fetch(AICHATTING_API_URL, {
                    method: "POST",
                    headers: {
                        "accept": "text/event-stream,application/json, text/event-stream",
                        "content-type": "application/json",
                        "lang": this.lang,
                        "origin": "https://www.aichatting.net",
                        "referer": "https://www.aichatting.net/",
                        "source": "web",
                        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
                        "vtoken": this.vtoken,
                    },
                    body: JSON.stringify(requestBodyPayload),
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                const contentType = response.headers.get("content-type") || "";

                // A. 检查是否直接返回了 JSON 错误 (如额度用尽)
                if (contentType.includes("application/json") || !response.ok) {
                    const text = await response.text();
                    let isExhausted = false;
                    try {
                        const json = JSON.parse(text);
                        if (
                            json.code === -1 ||
                            (typeof json.message === "string" && json.message.toLowerCase().includes("quota"))
                        ) {
                            isExhausted = true;
                        }
                    } catch {
                        if (text.toLowerCase().includes("quota") || text.toLowerCase().includes("exhausted")) {
                            isExhausted = true;
                        }
                    }

                    if (isExhausted && this.autoRotateOnExhaust && attempt < maxRetries) {
                        const oldId = this.visitorId;
                        const newId = this.resetVisitor();
                        yield `[系统提示: 访客(${oldId.slice(0, 8)}...)额度耗尽，已自动更换全新凭据(${newId.slice(0, 8)}...)重试中...]\n\n`;
                        continue;
                    }

                    throw new Error(`[AIChatting API Error ${response.status}]: ${text}`);
                }

                // B. 解析 SSE 流式文本
                if (!response.body) {
                    throw new Error("Response body is null");
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";
                const fullResponseParts: string[] = [];

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n");
                        buffer = lines.pop() || "";

                        for (const rawLine of lines) {
                            const trimmed = rawLine.trim();
                            if (!trimmed || !trimmed.startsWith("data:")) {
                                continue;
                            }

                            const data = trimmed.slice(5); // 去除 'data:' 前缀
                            if (data === "--@DONE@--") {
                                break;
                            }

                            const decoded = decodeStreamChunk(data);
                            if (decoded) {
                                fullResponseParts.push(decoded);
                                yield decoded;
                            }
                        }
                    }
                } finally {
                    try {
                        await reader.cancel();
                    } catch {
                        // 忽略关闭异常
                    }
                }

                // 更新对话上下文历史
                const completeAnswer = fullResponseParts.join("");
                if (typeof input === "string" && completeAnswer) {
                    this.history.push({ role: "user", content: userQuestion });
                    this.history.push({ role: "assistant", content: completeAnswer });
                }

                return;
            } catch (err: any) {
                clearTimeout(timeoutId);
                if (options.signal?.aborted) {
                    throw new Error("Request aborted");
                }

                if (attempt < maxRetries && this.autoRotateOnExhaust) {
                    this.resetVisitor();
                    continue;
                }
                throw err;
            }
        }
    }

    /**
     * 非流式完整调用
     * @param input 提问内容或消息列表
     * @param options 配置项
     * @returns 完整的回答文本
     */
    public async chat(
        input: string | ChatMessage[],
        options: ChatStreamOptions = {}
    ): Promise<string> {
        const chunks: string[] = [];
        for await (const chunk of this.chatStream(input, options)) {
            if (chunk.startsWith("[系统提示:")) continue;
            chunks.push(chunk);
        }
        return chunks.join("");
    }
}

// 默认单例
export const defaultAIChattingClient = new AIChattingClient();

// ================================================================================
// 命令行交互与独立测试入口
// ================================================================================

async function runCli() {
    console.log("=".repeat(70));
    console.log(" AIChatting (aichatting.net) 免登录逆向客户端 - TypeScript 终端交互测试");
    console.log("=".repeat(70));

    const client = new AIChattingClient();
    console.log(`[*] 初始化访客 ID : ${client.visitorId}`);
    console.log(`[*] 生成 RSA vtoken: ${client.vtoken.slice(0, 32)}...`);
    console.log(`[*] 默认模型       : ${client.defaultModel}`);
    console.log(`[*] 额度无限续杯   : 已开启 (自动检测并秒级换号重试)\n`);

    console.log("指令说明:");
    console.log("  - 直接输入问题按回车: 开始 AI 对话 (流式打字机输出)");
    console.log("  - 输入 'reset': 手动强制生成全新访客 ID 与加密凭据");
    console.log("  - 输入 'new'  : 清空上下文记忆，开始全新对话");
    console.log("  - 输入 'exit' 或 'quit': 退出测试程序\n");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const promptUser = () => {
        rl.question("User > ", async (userInput) => {
            const input = userInput.trim();
            if (!input) {
                promptUser();
                return;
            }

            if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
                console.log("已退出程序。");
                rl.close();
                process.exit(0);
            }

            if (input.toLowerCase() === "reset") {
                const newId = client.resetVisitor();
                console.log(`[*] 已手动刷新访客凭据: ${newId} (vtoken已重新生成)\n`);
                promptUser();
                return;
            }

            if (input.toLowerCase() === "new") {
                client.newChat();
                console.log("[*] 已清空上下文，开启新对话。\n");
                promptUser();
                return;
            }

            process.stdout.write("AI   > ");
            try {
                for await (const chunk of client.chatStream(input)) {
                    process.stdout.write(chunk);
                }
                console.log("\n");
            } catch (err: any) {
                console.error(`\n[请求错误]: ${err?.message || err}\n`);
            }

            promptUser();
        });
    };

    promptUser();
}

// 若作为主脚本直接执行则启动交互命令行
const isDirectRun =
    typeof process !== "undefined" &&
    process.argv &&
    process.argv[1] &&
    (process.argv[1].endsWith("aichatting.ts") || process.argv[1].endsWith("aichatting.js"));

if (isDirectRun) {
    runCli();
}

