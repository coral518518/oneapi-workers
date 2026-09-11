import { Context } from "hono";
import {
    defaultNoteGPTClient,
    buildPromptFromOpenAIMessages,
} from "./notegpt";

export default {
    async fetch(
        c: Context<HonoCustomType>,
        config: ChannelConfig,
        requestBody: any,
        saveUsage: (usage: Usage) => Promise<void>
    ): Promise<Response> {
        const stream = Boolean(requestBody.stream);
        const originalModel = requestBody.model || "gemini-3.1-flash-lite";

        // NoteGPT 模型名，若请求为 notegpt 或空则默认 gemini-3.1-flash-lite
        const targetModel = (requestBody.model && requestBody.model.toLowerCase() !== "notegpt")
            ? requestBody.model
            : "gemini-3.1-flash-lite";

        const promptText = buildPromptFromOpenAIMessages(requestBody.messages, requestBody.prompt);
        if (!promptText.trim()) {
            return new Response(
                JSON.stringify({
                    error: {
                        message: "Prompt or messages content cannot be empty",
                        type: "invalid_request_error",
                        code: "empty_prompt",
                    },
                }),
                {
                    status: 400,
                    headers: { "content-type": "application/json; charset=utf-8" },
                }
            );
        }

        const chatId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);

        // A. 流式处理 (OpenAI SSE 规范)
        if (stream) {
            const encoder = new TextEncoder();
            const readableStream = new ReadableStream({
                async start(controller) {
                    let fullReply = "";
                    try {
                        // 1. 发送流起始首包 (role: assistant)
                        const initialChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created,
                            model: originalModel,
                            choices: [
                                {
                                    index: 0,
                                    delta: { role: "assistant", content: "" },
                                    finish_reason: null,
                                },
                            ],
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

                        // 2. 消费 NoteGPT SSE 流式分片并转换为 OpenAI chunk
                        for await (const piece of defaultNoteGPTClient.chatStream(promptText, targetModel, 3)) {
                            fullReply += piece;
                            const deltaChunk = {
                                id: chatId,
                                object: "chat.completion.chunk",
                                created,
                                model: originalModel,
                                choices: [
                                    {
                                        index: 0,
                                        delta: { content: piece },
                                        finish_reason: null,
                                    },
                                ],
                            };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(deltaChunk)}\n\n`));
                        }

                        // 3. 计算 Token 消耗并发送尾包
                        const promptTokens = Math.max(1, Math.ceil(promptText.length / 3));
                        const completionTokens = Math.max(1, Math.ceil(fullReply.length / 3));
                        const usage: Usage = {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokens,
                            total_tokens: promptTokens + completionTokens,
                        };

                        const finalChunk = {
                            id: chatId,
                            object: "chat.completion.chunk",
                            created,
                            model: originalModel,
                            choices: [
                                {
                                    index: 0,
                                    delta: {},
                                    finish_reason: "stop",
                                },
                            ],
                            usage,
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();

                        // 4. 保存配额统计
                        c.executionCtx.waitUntil(
                            saveUsage(usage).catch((err) => {
                                console.error("[NoteGPT] Error saving usage in stream:", err);
                            })
                        );
                    } catch (err: any) {
                        console.error("[NoteGPT Stream Error]:", err);
                        const errChunk = {
                            error: {
                                message: err?.message || "Internal error occurred in NoteGPT stream",
                                type: "internal_error",
                                code: "notegpt_error",
                            },
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                        controller.close();
                    }
                },
            });

            return new Response(readableStream, {
                status: 200,
                headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache",
                    "connection": "keep-alive",
                },
            });
        }

        // B. 非流式处理 (OpenAI JSON 规范)
        try {
            const fullReply = await defaultNoteGPTClient.chat(promptText, targetModel, 3);

            const promptTokens = Math.max(1, Math.ceil(promptText.length / 3));
            const completionTokens = Math.max(1, Math.ceil(fullReply.length / 3));
            const usage: Usage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            };

            const responseData = {
                id: chatId,
                object: "chat.completion",
                created,
                model: originalModel,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: "assistant",
                            content: fullReply,
                        },
                        finish_reason: "stop",
                    },
                ],
                usage,
            };

            c.executionCtx.waitUntil(
                saveUsage(usage).catch((err) => {
                    console.error("[NoteGPT] Error saving usage:", err);
                })
            );

            return new Response(JSON.stringify(responseData), {
                status: 200,
                headers: {
                    "content-type": "application/json; charset=utf-8",
                },
            });
        } catch (err: any) {
            console.error("[NoteGPT Error]:", err);
            return new Response(
                JSON.stringify({
                    error: {
                        message: err?.message || "NoteGPT service request failed",
                        type: "api_error",
                        code: "notegpt_upstream_error",
                    },
                }),
                {
                    status: 502,
                    headers: {
                        "content-type": "application/json; charset=utf-8",
                    },
                }
            );
        }
    },
};

