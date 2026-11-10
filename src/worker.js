// Cloudflare Worker 진입점
// /api/name   : 이름 짓기
// /api/health : AI 연결 진단 (브라우저로 열어서 확인)
// 나머지 주소 : public 폴더의 파일
import { onRequestPost } from "../functions/api/name.js";

const VERSION = "v9";
const json = (b, status = 200) =>
  new Response(JSON.stringify(b, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function health(env) {
  const key = env.ANTHROPIC_API_KEY || "";
  const out = {
    version: VERSION,
    api_key_found: !!key,
    api_key_format_ok: key.startsWith("sk-ant-"),
    model: env.MODEL || "claude-haiku-5-5",
  };
  if (!key) { out.result = "API 키가 없어요. Cloudflare > Worker > Settings > Variables and Secrets 에 ANTHROPIC_API_KEY 를 Secret 으로 넣고 Deploy 하세요."; return json(out); }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: out.model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
    });
    out.anthropic_status = r.status;
    if (r.ok) out.result = "정상이에요. AI 작명이 동작해야 해요.";
    else {
      const t = await r.text();
      let msg = t.slice(0, 300);
      try { const e = JSON.parse(t); msg = (e.error && (e.error.type + ": " + e.error.message)) || msg; } catch (_) {}
      out.anthropic_error = msg;
      out.result = {
        401: "API 키가 틀렸어요. Anthropic 콘솔에서 키를 새로 만들어 다시 넣어 주세요.",
        403: "이 키로는 사용 권한이 없어요. 콘솔의 조직/워크스페이스 설정을 확인하세요.",
        404: "모델 이름을 찾을 수 없어요. MODEL 변수를 확인하세요.",
        400: "요청이 거절됐어요. 크레딧 잔액이나 사용 한도를 확인하세요.",
        429: "사용 한도나 속도 제한에 걸렸어요. 콘솔 Billing 의 한도를 확인하세요.",
      }[r.status] || "Anthropic 쪽 문제예요. 잠시 뒤 다시 확인하세요.";
    }
  } catch (e) {
    out.result = "Anthropic 서버에 연결하지 못했어요: " + (e && e.message);
  }
  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return health(env);
    if (url.pathname === "/api/name") {
      if (request.method === "POST") return onRequestPost({ request, env, ctx });
      return json({ error: "method_not_allowed" }, 405);
    }
    return env.ASSETS.fetch(request);
  },
};
