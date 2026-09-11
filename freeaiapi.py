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
import random
import urllib.parse
import logging
import requests
from typing import Generator, Optional, Dict, Any, List

# 修复 Windows 控制台默认 GBK 编码打印 UTF-8 字符抛出 UnicodeEncodeError 的问题
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ==================== 日志配置 ====================
logger = logging.getLogger("NoteGPT")

def setup_logger(level: int = logging.INFO) -> logging.Logger:
    """配置 NoteGPT 统一日志格式"""
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        formatter = logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] [NoteGPT] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.setLevel(level)
    return logger

# 默认启用 INFO 级别日志
setup_logger(logging.INFO)

# ==================== 随机 User-Agent 生成器 ====================
def get_random_user_agent() -> str:
    """
    随机生成主流现代桌面浏览器 User-Agent (Chrome / Edge / Firefox / Safari)
    覆盖 Windows 10/11、macOS 等真实系统与现代真实版本号，告别固定虚假 UA
    """
    os_list = [
        "Windows NT 10.0; Win64; x64",
        "Windows NT 10.0; Win64; x64",
        "Macintosh; Intel Mac OS X 10_15_7",
        "Macintosh; Intel Mac OS X 14_5",
        "Macintosh; Intel Mac OS X 14_7_2",
        "Macintosh; Intel Mac OS X 15_2",
    ]
    chosen_os = random.choice(os_list)

    browser_choices = ["chrome", "chrome", "edge", "firefox"]
    if "Macintosh" in chosen_os:
        browser_choices.append("safari")

    browser_type = random.choice(browser_choices)

    if browser_type == "chrome":
        major = random.randint(125, 134)
        build = random.randint(6400, 6999)
        patch = random.randint(10, 199)
        return f"Mozilla/5.0 ({chosen_os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.{build}.{patch} Safari/537.36"

    elif browser_type == "edge":
        major = random.randint(125, 134)
        build = random.randint(6400, 6999)
        patch = random.randint(10, 199)
        return f"Mozilla/5.0 ({chosen_os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.{build}.{patch} Safari/537.36 Edg/{major}.0.{build}.{patch}"

    elif browser_type == "firefox":
        major = random.randint(126, 136)
        clean_os = chosen_os.split("; rv:")[0]
        return f"Mozilla/5.0 ({clean_os}; rv:{major}.0) Gecko/20100101 Firefox/{major}.0"

    else:  # safari
        safari_ver = f"{random.randint(17, 18)}.{random.randint(0, 5)}"
        webkit_ver = f"605.1.{random.randint(10, 15)}"
        return f"Mozilla/5.0 ({chosen_os}) AppleWebKit/{webkit_ver} (KHTML, like Gecko) Version/{safari_ver} Safari/{webkit_ver}"

# 默认初始匿名 ID
DEFAULT_ANONYMOUS_USER_ID = "6684840a-964a-4698-b969-e9e147f02ad2"

# 额度耗尽关键词列表
QUOTA_EXHAUSTED_KEYWORDS = [
    "quota", "limit", "额度", "用完", "耗尽", "次数", "exceed",
    "insufficient", "upgrade", "reach", "premium", "not enough"
]

DEFAULT_MODEL = "gemini-3.1-flash-lite"

class NoteGPTClient:
    """NoteGPT 官方免签协议客户端（支持动态凭证签发、额度探测、随机 UA 与自动换号无限续杯）"""

    BASE_URL = "https://notegpt.io"

    def __init__(self, anonymous_user_id: Optional[str] = None, debug: bool = False):
        self.anonymous_user_id = anonymous_user_id or DEFAULT_ANONYMOUS_USER_ID
        self.session = requests.Session()
        self.history: List[Dict[str, str]] = []  # 存储对话历史上下文
        self.cached_config: Optional[Dict[str, Any]] = None
        self.config_expire_time: float = 0
        self.user_agent = get_random_user_agent()

        if debug:
            logger.setLevel(logging.DEBUG)

        # 标准浏览器请求头
        self.headers = {
            "accept": "*/*",
            "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
            "origin": "https://notegpt.io",
            "referer": "https://notegpt.io/ai-agent",
            "user-agent": self.user_agent,
        }
        self.session.headers.update(self.headers)
        self._sync_cookie()
        logger.info(f"NoteGPTClient 初始化完成, 当前 anonymous_user_id: {self.anonymous_user_id}")
        logger.info(f"[UA生成] 初始随机 User-Agent: {self.user_agent}")

    def refresh_user_agent(self) -> str:
        """随机更换当前 Session 的 User-Agent，告别固定死 UA"""
        self.user_agent = get_random_user_agent()
        self.session.headers["user-agent"] = self.user_agent
        logger.info(f"[UA切换] 动态轮换 User-Agent: {self.user_agent}")
        return self.user_agent

    def _sync_cookie(self):
        """确保 Cookie 在请求头和 CookieJar 中双重生效，避免跨域或重定向丢失"""
        self.session.headers["cookie"] = f"anonymous_user_id={self.anonymous_user_id}"
        self.session.cookies.set("anonymous_user_id", self.anonymous_user_id, domain="notegpt.io")
        self.session.cookies.set("anonymous_user_id", self.anonymous_user_id, domain=".notegpt.io")

    def reset_user(self, new_user_id: Optional[str] = None, clear_history: bool = False) -> str:
        """
        重置匿名用户身份 ID，清空旧 Cookie 与服务端凭据缓存，并自动轮换全新随机 User-Agent
        :param new_user_id: 指定新的 UUID，不传则随机生成全新 UUID
        :param clear_history: 是否清空本地对话上下文历史（默认保留，以便换号后继续记忆）
        :return: 新的 anonymous_user_id
        """
        old_id = self.anonymous_user_id
        self.anonymous_user_id = new_user_id or str(uuid.uuid4())
        self.session.cookies.clear()
        self._sync_cookie()
        self.refresh_user_agent()
        self.cached_config = None
        self.config_expire_time = 0
        if clear_history:
            self.history.clear()
        logger.info(f"[身份重置] 已从旧 ID ({old_id[:8]}...) 切换至新 ID ({self.anonymous_user_id[:8]}...)，凭据已清空，UA已随机更新")
        return self.anonymous_user_id

    def new_chat(self):
        """开启全新对话，清空上下文历史"""
        self.history.clear()
        logger.info("[对话管理] 已清空上下文历史记录")

    def get_quota(self) -> Dict[str, Any]:
        """
        查询当前账号剩余免费额度 (GET /api/v2/user/quota?features=ai_chat)
        增加详细请求与返回日志
        """
        url = f"{self.BASE_URL}/api/v2/user/quota"
        params = {"features": "ai_chat"}
        headers = {"accept": "application/json, text/plain, */*"}
        logger.info(f"[额度查询] 发起请求: GET {url}, params={params}, anonymous_user_id={self.anonymous_user_id}")
        logger.debug(f"[额度查询] 请求头 Headers: {dict(self.session.headers)}")

        try:
            resp = self.session.get(url, params=params, headers=headers, timeout=10)
            logger.info(f"[额度查询] 响应状态码: HTTP {resp.status_code}")
            logger.debug(f"[额度查询] 响应原始报文: {resp.text}")

            try:
                data = resp.json()
                logger.info(f"[额度查询] 接口响应 JSON: {json.dumps(data, ensure_ascii=False)}")
                return data
            except Exception as json_err:
                logger.warning(f"[额度查询] 返回非 JSON 格式: {resp.text[:200]}, 错误: {json_err}")
                return {"status": resp.status_code, "raw": resp.text}
        except Exception as req_err:
            logger.error(f"[额度查询] 请求异常失败: {req_err}")
            return {"status": 0, "error": str(req_err)}

    def get_remaining_quota(self) -> int:
        """
        获取当前用户剩余的基础免费对话次数
        若查询失败返回 -1 (表示状态未知)，避免将网络或接口波动误判为额度归零
        """
        try:
            res = self.get_quota()
            if isinstance(res, dict) and res.get("code") == 100000:
                quota_info = res.get("data", {}).get("ai_chat", {}).get("basic_quota", {})
                remaining = quota_info.get("remaining")
                if remaining is not None:
                    rem_val = int(remaining)
                    total_val = quota_info.get("total", "未知")
                    logger.info(f"[额度解析] 查询成功: 剩余基础额度 = {rem_val} / 总额度 = {total_val}")
                    return rem_val
                logger.warning(f"[额度解析] 成功响应中缺失 basic_quota.remaining: {res.get('data')}")
            else:
                logger.warning(f"[额度解析] 额度查询未返回 code 100000: code={res.get('code')}, msg={res.get('message') or res.get('msg')}")
        except Exception as e:
            logger.error(f"[额度解析] 解析额度异常: {e}")
        return -1

    def get_valid_config(self, force_refresh: bool = False) -> Dict[str, Any]:
        """
        获取官方服务端下发的有效会话凭据（包含动态 t、nonce、sign、secret_key 等）
        此接口无需逆向前端 WASM，由 NoteGPT 官方服务器自动完成正规签名！
        """
        now = time.time()
        if not force_refresh and self.cached_config and now < self.config_expire_time:
            logger.debug(f"[凭据获取] 使用缓存凭据 (剩余有效期 {int(self.config_expire_time - now)}s)")
            return self.cached_config

        url = f"{self.BASE_URL}/api/v1/ai-tab/get-prod-config"
        logger.info(f"[凭据获取] 正在请求官方签名接口: GET {url}, anonymous_user_id={self.anonymous_user_id}")
        logger.debug(f"[凭据获取] 请求头: {dict(self.session.headers)}")

        try:
            resp = self.session.get(url, timeout=10)
            logger.info(f"[凭据获取] 接口响应状态: HTTP {resp.status_code}")
            logger.debug(f"[凭据获取] 原始报文: {resp.text}")
            data = resp.json()
        except Exception as e:
            logger.error(f"[凭据获取] 网络或解析异常: {e}")
            raise RuntimeError(f"获取官方凭据网络异常: {e}")

        logger.info(f"[凭据获取] 接口响应 JSON: {json.dumps(data, ensure_ascii=False)}")

        if data.get("code") == 100000 and "data" in data:
            self.cached_config = data["data"]
            # 凭据通常有效期为几分钟，此处缓存 60 秒
            self.config_expire_time = now + 60
            logger.info(
                f"[凭据获取] 鉴权成功！app_id: {self.cached_config.get('app_id')}, "
                f"uid: {self.cached_config.get('uid')}, "
                f"sign: {str(self.cached_config.get('sign'))[:10]}..., "
                f"t: {self.cached_config.get('t')}"
            )
            return self.cached_config
        else:
            logger.error(f"[凭据获取] 官方凭据签发失败: {data}")
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
        model: str = DEFAULT_MODEL,
        max_retries: int = 3,
        timeout: int = 30,
    ) -> Generator[str, None, None]:
        """
        发起 SSE 流式对话请求
        - 自动通过 get-prod-config 获取服务端签名
        - 自动检测额度耗尽、每次异常均调用查询额度接口
        - 自动换号并重新请求
        - 实时 yield 返回文字片段
        """
        # 每次发起新对话请求前均随机刷新 User-Agent，避免固定特征
        self.refresh_user_agent()

        logger.info(f"[对话开始] 发起流式对话, model: {model}, 消息长度: {len(message)}, 当前身份: {self.anonymous_user_id}, UA: {self.user_agent}")

        # 前置额度探测：调用查询额度接口进行预检
        logger.info("[对话前置] 正在调用额度查询接口探测当前账号剩余额度...")
        quota_rem = self.get_remaining_quota()
        if quota_rem == 0:
            old_id = self.anonymous_user_id
            new_id = self.reset_user()
            logger.warning(f"[对话前置] 检测到当前用户 ({old_id[:8]}...) 额度已为 0，已自动更换新身份: {new_id[:8]}...")
            yield f"[系统提示: 当前用户({old_id[:8]}...)额度已耗尽(剩余0次)，已自动更换新身份: {new_id[:8]}...]\n\n"
            # 换号后查询新身份额度
            self.get_remaining_quota()
        elif quota_rem < 0:
            logger.info("[对话前置] 额度查询未返回确切数字 (可能接口无基础额度字段或波动)，继续尝试请求对话")
        else:
            logger.info(f"[对话前置] 账号额度充足，剩余 {quota_rem} 次")

        prompt_text = self._build_prompt_with_history(message)

        for attempt in range(1, max_retries + 1):
            logger.info(f"[对话轮次] === 正在进行第 {attempt}/{max_retries} 次请求尝试 ===")
            try:
                # 1. 取得服务端合法动态鉴权参数（重试时强制刷新凭据，避免使用过期 sign）
                config_data = self.get_valid_config(force_refresh=(attempt > 1))
            except Exception as e:
                logger.error(f"[对话轮次] 获取鉴权凭据失败 ({attempt}/{max_retries}): {e}")
                # 凭据失败时调用查询额度接口排查
                logger.info("[对话轮次] 正在调用额度查询接口排查账号状态...")
                q_info = self.get_quota()
                logger.info(f"[对话轮次] 额度查询结果: {json.dumps(q_info, ensure_ascii=False)}")
                self.reset_user()
                continue

            # 构建请求体：注入完整对话参数与鉴权签名凭据（确保无论服务端从 query 还是 body 解析均能正确获取）
            payload = {
                "text": prompt_text,
                "prompt": prompt_text,
                "model": model,
                "end_flag": True,
                "streaming": True,
                "stream": True,
                "conversation_id": None,
                # 鉴权凭据注入 body
                "t": config_data.get("t"),
                "nonce": config_data.get("nonce"),
                "sign": config_data.get("sign"),
                "secret_key": config_data.get("secret_key"),
                "app_id": config_data.get("app_id"),
                "uid": config_data.get("uid"),
            }

            url = f"{self.BASE_URL}/api/v2/llm/question"
            req_headers = {
                "accept": "text/event-stream, application/json, */*",
                "content-type": "application/json",
            }

            logger.info(f"[对话请求] 发起 POST 对话请求: {url}, model={model}")
            logger.debug(f"[对话请求] Query Params: {config_data}")
            logger.debug(f"[对话请求] 请求载荷 Payload: {json.dumps(payload, ensure_ascii=False)}")

            try:
                resp = self.session.post(
                    url,
                    params=config_data,
                    json=payload,
                    headers=req_headers,
                    stream=True,
                    timeout=timeout,
                )
                resp.encoding = "utf-8"
                logger.info(f"[对话请求] 收到响应状态: HTTP {resp.status_code}, Content-Type: {resp.headers.get('content-type', '')}")
            except Exception as req_err:
                logger.error(f"[对话请求] 网络请求失败: {req_err}")
                yield f"\n[网络请求失败]: {req_err}"
                return

            # A. 状态码异常处理 (429/403)
            if resp.status_code in (429, 403):
                logger.warning(f"[对话请求] 触发 HTTP {resp.status_code} 限流/访问受限, 响应片段: {resp.text[:200]}")
                logger.info("[对话请求] 正在调用额度接口查询受限账号额度...")
                quota_info = self.get_quota()
                logger.info(f"[对话请求] 额度接口返回: {json.dumps(quota_info, ensure_ascii=False)}")

                old_id = self.anonymous_user_id
                new_id = self.reset_user()
                yield f"[系统提示: 触发限流/限制 (HTTP {resp.status_code})，已自动换号 {new_id[:8]}... 正在重试 ({attempt}/{max_retries})...]\n\n"
                continue

            # B. 接口直接返回 JSON 异常处理
            ctype = resp.headers.get("content-type", "")
            if "application/json" in ctype:
                try:
                    err_json = resp.json()
                    logger.warning(f"[对话请求] 接口直接返回 JSON 异常 (非 SSE 流): {json.dumps(err_json, ensure_ascii=False)}")

                    err_code = err_json.get("code")
                    err_msg = err_json.get("message") or err_json.get("msg") or "未知错误"
                    is_quota = self._is_quota_exhausted(err_json)

                    # 发生异常时，主动调用额度接口核实真实账号状态
                    logger.info("[对话请求] 接口返回异常，正在调用查询额度接口核实账号状态...")
                    quota_res = self.get_quota()
                    logger.info(f"[对话请求] 额度接口返回详细数据: {json.dumps(quota_res, ensure_ascii=False)}")

                    quota_rem_now = -1
                    if isinstance(quota_res, dict) and quota_res.get("code") == 100000:
                        quota_rem_now = quota_res.get("data", {}).get("ai_chat", {}).get("basic_quota", {}).get("remaining", -1)

                    # 逻辑判定 1：参数缺失 (164001: missing params / wrong params)
                    # NoteGPT 官方免签通道（basic_quota）仅对基础免费模型 gemini-3.1-flash-lite 授权；
                    # 若请求了其它高级模型 (如 gpt-5-mini, minimax-m3)，服务端会返回 164001
                    if err_code == 164001:
                        if model != "gemini-3.1-flash-lite":
                            logger.warning(
                                f"[模型自适应] 模型 '{model}' 不在当前免签基础通道支持列表 (服务端返回: {err_msg}, code: 164001)。"
                                f"当前账号额度尚存 {quota_rem_now} 次，正在自动无缝切换为官方支持的基础模型 'gemini-3.1-flash-lite' 继续完成回答..."
                            )
                            yield f"[系统提示: 模型 '{model}' 属于网页端高级通道模型，当前免签通道已自动切换为基础免费模型 'gemini-3.1-flash-lite']\n\n"
                            model = "gemini-3.1-flash-lite"
                            continue
                        else:
                            logger.error(f"[对话请求] 基础模型亦返回 missing params (code 164001)。当前账号额度尚存 {quota_rem_now} 次，终止重试。")
                            yield f"\n[接口参数错误: 164001 missing params] 接口提示参数缺失或格式不匹配。当前账号剩余额度仍有: {quota_rem_now} 次 (未耗尽)。"
                            return

                    # 逻辑判定 2：如果额度查询明确显示剩余额度 > 0，且并未报额度耗尽关键词，则说明账号正常
                    if quota_rem_now > 0 and not is_quota:
                        logger.error(f"[对话请求] 接口返回业务错误: code={err_code}, msg='{err_msg}'。账号额度充足 (剩余 {quota_rem_now} 次)，非额度问题，终止重试。")
                        yield f"\n[接口业务错误: code {err_code}]: {err_msg} (当前账号额度充足: 剩余 {quota_rem_now} 次)"
                        return

                    # 逻辑判定 3：确属额度耗尽 (quota_rem == 0 或返回额度关键词) 或凭据过期失效 (164003, 164005) 时，才触发自动换号
                    if is_quota or quota_rem_now == 0 or err_code in (164003, 164005):
                        reason = "额度耗尽(剩余0次)" if (is_quota or quota_rem_now == 0) else f"凭据失效(code:{err_code})"
                        logger.warning(f"[对话请求] 确属 {reason}，触发自动换号重试 (报错原因: {err_msg})")

                        old_id = self.anonymous_user_id
                        new_id = self.reset_user()
                        yield f"[系统提示: 接口检测到{reason}，已自动更换新身份 {new_id[:8]}... 重新请求 ({attempt}/{max_retries})...]\n\n"
                        continue

                    logger.error(f"[对话请求] 接口返回不可恢复的业务错误: {err_json}")
                    yield f"\n[接口返回错误]: {json.dumps(err_json, ensure_ascii=False)}"
                    return
                except Exception as json_err:
                    logger.warning(f"[对话请求] 解析 JSON 报文异常: {json_err}, 原始文本: {resp.text[:300]}")

            if resp.status_code != 200:
                logger.error(f"[对话请求] HTTP 状态码异常: {resp.status_code}, 响应内容: {resp.text[:400]}")
                logger.info("[对话请求] 异常状态下调用额度查询接口...")
                q_err = self.get_quota()
                logger.info(f"[对话请求] 额度接口返回: {json.dumps(q_err, ensure_ascii=False)}")
                yield f"\n[HTTP 异常: {resp.status_code}]: {resp.text}"
                return

            # C. 正常读取并解析 SSE 数据流
            logger.info("[对话请求] 成功建立 SSE 流连接，开始接收流式文本分片...")
            full_reply_parts = []
            quota_exhausted_in_stream = False
            last_event = None

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
                    last_event = event_data
                    if isinstance(event_data, dict):
                        if self._is_quota_exhausted(event_data):
                            logger.warning(f"[对话请求] 数据流中检测到额度耗尽事件: {event_data}")
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

            # 若流中检测到超额，调用额度接口查询确认，换号并重新请求
            if quota_exhausted_in_stream:
                logger.warning("[对话请求] 流式传输中途额度耗尽，正在调用额度查询接口...")
                quota_info = self.get_quota()
                logger.info(f"[对话请求] 额度接口返回: {json.dumps(quota_info, ensure_ascii=False)}")

                old_id = self.anonymous_user_id
                new_id = self.reset_user()
                yield f"\n[系统提示: 流式传输中检测到额度耗尽，已自动切换新身份 {new_id[:8]}... 正在重试 ({attempt}/{max_retries})...]\n\n"
                continue

            # 成功回答后，将本轮对话计入历史记录
            full_answer = "".join(full_reply_parts)
            if full_answer:
                logger.info(f"[对话请求] 对话顺利完成！共获取 {len(full_reply_parts)} 个分片，累计 {len(full_answer)} 字符")
                self.history.append({"question": message, "answer": full_answer})
                return
            else:
                logger.warning(f"[对话请求] 数据流关闭但未收到任何文本片段 (最后事件: {last_event})，准备重试...")

        logger.error(f"[对话请求] 连续重试 {max_retries} 次仍未成功，请求终止")
        logger.info("[对话请求] 最终重试失败后，调用额度接口查看当前状态...")
        final_quota = self.get_quota()
        logger.info(f"[对话请求] 最终额度接口返回: {json.dumps(final_quota, ensure_ascii=False)}")
        yield f"\n[系统错误: 连续重试 {max_retries} 次仍未成功，请查看上方日志输出排查接口返回信息]"

    def chat(self, message: str, model: str = DEFAULT_MODEL) -> str:
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

    current_model = DEFAULT_MODEL
    print("[*] 正在向官方服务端查询剩余额度...")
    remaining = client.get_remaining_quota()
    print(f"[*] 当前匿名身份: {client.anonymous_user_id}")
    print(f"[*] 当前 User-Agent: {client.user_agent}")
    print(f"[*] 当前默认模型: {current_model}")
    print(f"[*] 当前可用额度: {remaining if remaining >= 0 else '未知'} 次 (基础通道仅限基础免费模型)")

    print("\n支持指令:")
    print("  - 直接输入问题回车: 开始 AI 对话")
    print("  - 输入 'model [模型名]': 查看或切换模型 (官方免签基础通道默认使用 gemini-3.1-flash-lite)")
    print("  - 输入 'reset': 手动强制生成新身份 (同时自动更换 UA)")
    print("  - 输入 'ua': 查看当前或随机更换全新 User-Agent")
    print("  - 输入 'quota': 查看当前用户额度详情并输出日志")
    print("  - 输入 'debug': 切换 DEBUG 详细日志开关")
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

            if msg.lower().startswith("model"):
                parts = msg.split(maxsplit=1)
                if len(parts) > 1:
                    current_model = parts[1].strip()
                    print(f"[*] 已切换当前模型为: {current_model}\n")
                else:
                    print(f"[*] 当前使用模型为: {current_model}\n")
                continue

            if msg.lower() == "reset":
                new_id = client.reset_user()
                rem = client.get_remaining_quota()
                print(f"[*] 已手动重置身份为: {new_id}，当前剩余额度: {rem if rem >= 0 else '未知'} 次")
                print(f"[*] 已自动更换 User-Agent: {client.user_agent}\n")
                continue

            if msg.lower() == "ua":
                new_ua = client.refresh_user_agent()
                print(f"[*] 已随机更换 User-Agent 为: {new_ua}\n")
                continue

            if msg.lower() == "quota":
                q = client.get_quota()
                print(f"[*] 配额详情: {json.dumps(q, ensure_ascii=False, indent=2)}\n")
                continue

            if msg.lower() == "debug":
                current_level = logger.getEffectiveLevel()
                if current_level == logging.DEBUG:
                    logger.setLevel(logging.INFO)
                    print("[*] 已切换日志级别为: INFO\n")
                else:
                    logger.setLevel(logging.DEBUG)
                    print("[*] 已切换日志级别为: DEBUG (显示请求头和原始报文)\n")
                continue

            if msg.lower() == "new":
                client.history.clear()
                print("[*] 已清空上下文，开启全新对话。\n")
                continue

            print("AI   > ", end="", flush=True)
            for token in client.chat_stream(message=msg, model=current_model):
                print(token, end="", flush=True)
            print("\n")

        except KeyboardInterrupt:
            print("\n操作已中断。")
            break


if __name__ == "__main__":
    main()


