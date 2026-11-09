// Cloudflare Worker 진입점
// /api/name 은 이름 짓기 서버로, 나머지 주소는 public 폴더의 파일로 보냄
import { onRequestPost } from "../functions/api/name.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/name") {
      if (request.method === "POST") return onRequestPost({ request, env, ctx });
      return new Response(JSON.stringify({ error: "method_not_allowed" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
