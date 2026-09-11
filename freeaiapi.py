# -*- coding: utf-8 -*-
"""
================================================================================
NoteGPT 免费 AI 接口分析与免网页直接请求脚本
================================================================================

 正确的官方免加密破解调用流程 (经反编译 Nuxt 核心源码提取):
   - 第一步: 先调用官方免签配置接口:
     GET https://notegpt.io/api/v1/ai-tab/get-prod-config
     服务端会依据当前访问者的 Cookie (anonymous_user_id)，直接在下发的 JSON 中签发合法凭据:
     { "t": 1789..., "nonce": "...", "sign": "...", "secret_key": "...", "app_id": "nc_ai_ng", "uid": "..." }
   - 第二步: 将上述服务端签发的参数作为 URL Query 参数，发起真正的流式对话请求:
     POST https://notegpt.io/api/v2/llm/question?<query_params>
     载荷 JSON: {"text": "提问内容", "end_flag": True, "streaming": True, "model": "gemini-3.1-flash-lite"}
   - 第三步: 服务端返回标准的 SSE (text/event-stream) 格式，数据形如:
     data: {"message": "回答分片", "conversation_id": null}
     data: [DONE]

 额度机制与无限续杯:
   - 额度与 Cookie 中的 `anonymous_user_id` (UUID) 绑定，每个新 ID 拥有免费对话额度。
   - 当检测到额度耗尽时，只需生成新 UUID 并重新调用 `get-prod-config`，即可零成本无限换号！
================================================================================
"""

import sys
import json
import time
import uuid
import urllib.parse
import requests
from typing import Generator, Optional, Dict, Any, List

# 修复 Windows 控制台默认 GBK 编码打印 UTF-8 字符抛出 UnicodeEncodeError 的问题
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 默认初始匿名 ID
DEFAULT_ANONYMOUS_USER_ID = "6684840a-964a-4698-b969-e9e147f02ad2"

# 额度耗尽关键词列表
QUOTA_EXHAUSTED_KEYWORDS = [
    "quota", "limit", "额度", "用完", "耗尽", "次数", "exceed",
    "insufficient", "upgrade", "reach", "premium", "not enough"
]


class NoteGPTClient:
    """NoteGPT 官方免签协议客户端（支持动态凭证签发与自动换号无限续杯）"""

    BASE_URL = "https://notegpt.io"

    def __init__(self, anonymous_user_id: Optional[str] = None):
        self.anonymous_user_id = anonymous_user_id or DEFAULT_ANONYMOUS_USER_ID
        self.session = requests.Session()
        self.history: List[Dict[str, str]] = []  # 存储对话历史上下文
        self.cached_config: Optional[Dict[str, Any]] = None
        self.config_expire_time: float = 0

        # 标准浏览器请求头
        self.headers = {
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "origin": "https://notegpt.io",
            "referer": "https://notegpt.io/ai-agent",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/147.0.0.0 Safari/537.36"
            ),
        }
        self.session.headers.update(self.headers)
        self.session.cookies.set("anonymous_user_id", self.anonymous_user_id)

    def reset_user(self, new_user_id: Optional[str] = None, clear_history: bool = False) -> str:
        """
        重置匿名用户身份 ID，清空旧 Cookie 与服务端凭据缓存
        :param new_user_id: 指定新的 UUID，不传则随机生成全新 UUID
        :param clear_history: 是否清空本地对话上下文历史（默认保留，以便换号后继续记忆）
        :return: 新的 anonymous_user_id
        """
        self.anonymous_user_id = new_user_id or str(uuid.uuid4())
        self.session.cookies.clear()
        self.session.cookies.set("anonymous_user_id", self.anonymous_user_id)
        self.cached_config = None
        self.config_expire_time = 0
        if clear_history:
            self.history.clear()
        return self.anonymous_user_id

    def new_chat(self):
        """开启全新对话，清空上下文历史"""
        self.history.clear()

    def get_quota(self) -> Dict[str, Any]:
        """查询当前账号剩余免费额度 (GET /api/v2/user/quota?features=ai_chat)"""
        url = f"{self.BASE_URL}/api/v2/user/quota"
        headers = {"accept": "application/json, text/plain, */*"}
        resp = self.session.get(url, params={"features": "ai_chat"}, headers=headers, timeout=10)
        try:
            return resp.json()
        except Exception:
            return {"status": resp.status_code, "raw": resp.text}

    def get_remaining_quota(self) -> int:
        """获取当前用户剩余的基础免费对话次数"""
        try:
            res = self.get_quota()
            if res.get("code") == 100000:
                return res.get("data", {}).get("ai_chat", {}).get("basic_quota", {}).get("remaining", 0)
        except Exception:
            pass
        return 0

    def get_valid_config(self, force_refresh: bool = False) -> Dict[str, Any]:
        """
        获取官方服务端下发的有效会话凭据（包含动态 t、nonce、sign、secret_key 等）
        此接口无需逆向前端 WASM，由 NoteGPT 官方服务器自动完成正规签名！
        """
        now = time.time()
        if not force_refresh and self.cached_config and now < self.config_expire_time:
            return self.cached_config

        url = f"{self.BASE_URL}/api/v1/ai-tab/get-prod-config"
        resp = self.session.get(url, timeout=10)
        data = resp.json()

        if data.get("code") == 100000 and "data" in data:
            self.cached_config = data["data"]
            # 凭据通常有效期为几分钟，此处缓存 60 秒
            self.config_expire_time = now + 60
            return self.cached_config
        else:
            raise RuntimeError(f"获取官方凭据失败: {data}")

    def _is_quota_exhausted(self, response_data: Any) -> bool:
        """判断返回结果是否代表额度用尽"""
        text = json.dumps(response_data, ensure_ascii=False) if isinstance(response_data, (dict, list)) else str(response_data)
        text_lower = text.lower()
        return any(kw in text_lower for kw in QUOTA_EXHAUSTED_KEYWORDS)

    def _build_prompt_with_history(self, current_message: str) -> str:
        """根据历史对话构建上下文提示词"""
        if not self.history:
            return current_message

        parts = []
        for turn in self.history[-6:]:  # 保留最近 3 轮对话
            parts.append(f"用户: {turn['question']}\nAI: {turn['answer']}")
        parts.append(f"用户: {current_message}\nAI:")
        return "\n\n".join(parts)

    def chat_stream(
        self,
        message: str,
        model: str = "gemini-3.1-flash-lite",
        max_retries: int = 3,
        timeout: int = 30,
    ) -> Generator[str, None, None]:
        """
        发起 SSE 流式对话请求
        - 自动通过 get-prod-config 获取服务端签名
        - 自动检测额度耗尽、自动换号并重新请求
        - 实时 yield 返回文字片段
        """
        # 前置额度探测：若当前号额度已为 0，直接自动换号
        if self.get_remaining_quota() <= 0:
            old_id = self.anonymous_user_id
            new_id = self.reset_user()
            yield f"[系统提示: 当前用户({old_id[:8]}...)额度已耗尽，已自动更换新身份: {new_id[:8]}...]\n\n"

        prompt_text = self._build_prompt_with_history(message)

        for attempt in range(1, max_retries + 1):
            try:
                # 1. 取得服务端合法动态鉴权参数
                config_data = self.get_valid_config(force_refresh=(attempt > 1))
            except Exception as e:
                # 凭据获取失败可能是 IP/ID 受限，重置用户重试
                self.reset_user()
                continue

            query_str = urllib.parse.urlencode(config_data)
            url = f"{self.BASE_URL}/api/v2/llm/question?{query_str}"

            payload = {
                "text": prompt_text,
                "end_flag": True,
                "streaming": True,
                "model": model,
            }

            try:
                resp = self.session.post(url, json=payload, stream=True, timeout=timeout)
                resp.encoding = "utf-8"
            except Exception as req_err:
                yield f"\n[网络请求失败]: {req_err}"
                return

            # A. 状态码异常处理 (429/403)
            if resp.status_code in (429, 403):
                old_id = self.anonymous_user_id
                new_id = self.reset_user()
                yield f"[系统提示: 触发限流/限制 (HTTP {resp.status_code})，已自动换号 {new_id[:8]}... 正在重试 ({attempt}/{max_retries})...]\n\n"
                continue

            # B. 接口直接返回 JSON 异常处理
            ctype = resp.headers.get("content-type", "")
            if "application/json" in ctype:
                try:
                    err_json = resp.json()
                    # 检查是否额度耗尽或凭证失效
                    if self._is_quota_exhausted(err_json) or err_json.get("code") in (164001, 164003, 164005):
                        old_id = self.anonymous_user_id
                        new_id = self.reset_user()
                        yield f"[系统提示: 接口提示额度不足或凭据过期，已自动更换新身份 {new_id[:8]}... 重新请求 ({attempt}/{max_retries})...]\n\n"
                        continue
                    yield f"\n[接口返回错误]: {json.dumps(err_json, ensure_ascii=False)}"
                    return
                except Exception:
                    pass

            if resp.status_code != 200:
                yield f"\n[HTTP 异常: {resp.status_code}]: {resp.text}"
                return

            # C. 正常读取并解析 SSE 数据流 (以 UTF-8 原始字节精确解码，避免 requests 默认的 ISO-8859-1 乱码)
            full_reply_parts = []
            quota_exhausted_in_stream = False

            for raw_bytes in resp.iter_lines():
                if not raw_bytes:
                    continue

                line = raw_bytes.decode("utf-8", errors="replace").strip()
                # 忽略 SSE 协议头行 (id:, event:)
                if line.startswith("id:") or line.startswith("event:"):
                    continue

                if line.startswith("data:"):
                    raw = line[len("data:"):].strip()
                else:
                    continue

                if not raw or raw == "[DONE]":
                    break

                try:
                    event_data = json.loads(raw)
                    if isinstance(event_data, dict):
                        if self._is_quota_exhausted(event_data):
                            quota_exhausted_in_stream = True
                            break

                        # 提取返回文本分片
                        piece = event_data.get("message") or event_data.get("text") or ""
                        if piece:
                            full_reply_parts.append(piece)
                            yield piece
                    elif isinstance(event_data, str):
                        full_reply_parts.append(event_data)
                        yield event_data
                except json.JSONDecodeError:
                    pass

            # 若流中检测到超额，换号并重新请求
            if quota_exhausted_in_stream:
                old_id = self.anonymous_user_id
                new_id = self.reset_user()
                yield f"\n[系统提示: 流式传输中检测到额度耗尽，已自动切换新身份 {new_id[:8]}... 正在重试 ({attempt}/{max_retries})...]\n\n"
                continue

            # 成功回答后，将本轮对话计入历史记录
            full_answer = "".join(full_reply_parts)
            if full_answer:
                self.history.append({"question": message, "answer": full_answer})
            return

        yield f"\n[系统错误: 连续重试 {max_retries} 次仍未成功，请检查网络]"

    def chat(self, message: str, model: str = "gemini-3.1-flash-lite") -> str:
        """非流式调用，聚合所有回答文本并返回完整内容"""
        chunks = []
        for piece in self.chat_stream(message, model=model):
            if piece.strip().startswith("[系统提示:"):
                continue
            chunks.append(piece)
        return "".join(chunks)


# ================= 命令行测试与交互 =================
def main():
    print("=" * 65)
    print(" NoteGPT 独立请求脚本 (官方免签通道 + 额度耗尽自动无限换号)")
    print("=" * 65)

    client = NoteGPTClient()

    print("[*] 正在向官方服务端申请鉴权凭证...")
    try:
        cfg = client.get_valid_config()
        print(f"[*] 鉴权成功！服务器分配 app_id: {cfg.get('app_id')}")
    except Exception as e:
        print(f"[!] 凭据获取提示: {e}")

    remaining = client.get_remaining_quota()
    print(f"[*] 当前匿名身份: {client.anonymous_user_id}")
    print(f"[*] 当前可用额度: {remaining} 次 (额度耗尽后将自动无感换号)")

    print("\n支持指令:")
    print("  - 直接输入问题回车: 开始 AI 对话")
    print("  - 输入 'reset': 手动强制生成新身份")
    print("  - 输入 'quota': 查看当前用户额度详情")
    print("  - 输入 'new': 清空对话历史上下文")
    print("  - 输入 'quit' 或 'exit': 退出程序\n")

    while True:
        try:
            msg = input("User > ").strip()
            if not msg:
                continue

            if msg.lower() in ("exit", "quit"):
                print("程序已退出。")
                break

            if msg.lower() == "reset":
                new_id = client.reset_user()
                rem = client.get_remaining_quota()
                print(f"[*] 已手动重置身份为: {new_id}，当前剩余额度: {rem} 次\n")
                continue

            if msg.lower() == "quota":
                q = client.get_quota()
                print(f"[*] 配额详情: {json.dumps(q, ensure_ascii=False, indent=2)}\n")
                continue

            if msg.lower() == "new":
                client.history.clear()
                print("[*] 已清空上下文，开启全新对话。\n")
                continue

            print("AI   > ", end="", flush=True)
            for token in client.chat_stream(message=msg):
                print(token, end="", flush=True)
            print("\n")

        except KeyboardInterrupt:
            print("\n操作已中断。")
            break


if __name__ == "__main__":
    main()

