// POST /api/name
// 입력: { sur: {kanji, kr, raw}, giv: [{kanji, kr, raw}, ...] }
// 출력: { surname, given, names: [...], note, cached }
//
// 필요한 설정 (Cloudflare Pages > Settings)
//   Secret   ANTHROPIC_API_KEY   : Anthropic API 키
//   Variable MODEL               : 기본 claude-haiku-5-5
//   (선택) KV binding NAMES      : 유료 플랜용. 연결하면 공용 캐시 + 속도 제한 + 하루 한도 사용
//   Variable DAILY_CALL_LIMIT    : KV 연결 시 하루 최대 AI 호출 수 (기본 30000)
//   Variable IP_LIMIT_PER_10MIN  : KV 연결 시 IP 하나당 10분 최대 요청 수 (기본 20)
// KV 없이도 동작해요(무료 플랜). 이때 비용 상한은 Anthropic 콘솔의 월 사용 한도로 지켜요.

const HAN = /\p{Script=Han}/u;
const KANA = /^[ぁ-ゖァ-ヶー]+$/;

function clean(s, max = 20) {
  return String(s ?? "").replace(/[\u0000-\u001f<>{}`$\\"]/g, "").trim().slice(0, max);
}

function part(x) {
  if (!x || typeof x !== "object") return null;
  const kanji = clean(x.kanji, 2);
  const out = {
    kanji: HAN.test(kanji) ? [...kanji][0] : "",
    kr: clean(x.kr, 12),
    raw: clean(x.raw, 16),
  };
  if (!out.kanji && !out.raw) return null;
  return out;
}

function buildPrompt(sur, giv) {
  const desc = (x) =>
    x.kanji ? `${x.kanji}${x.kr ? ` (${x.kr})` : ""}` : `"${x.raw}" (한국어 훈음 설명. 인명용 한자 하나로 확정할 것)`;
  return `너는 한국 사람 이름의 한자를 일본식으로 읽어서 '재미로' 일본 이름을 지어주는 작명가야.

입력
- 성: ${desc(sur)}
- 이름 글자(순서대로): ${giv.map(desc).join(" / ")}

규칙
1. 성은 한자 한 글자를 그대로 유지하고, 일본어로 읽는 방법만 고른다(훈독 또는 음독). 글자를 덧붙이거나 바꾸지 마.
2. 이름은 원래 한자를 원래 순서대로 쓰고, 각 글자를 음독·훈독·이름용 읽기(名乗り) 중 하나로 읽는다.
3. 그 한자에 실제로 있는 읽기만 사용한다. 없는 읽기를 지어내지 마.
4. 일본 이름으로 자연스럽게 들리는 조합 3개를 추천 순으로. 성 읽기는 같아도 되지만 세 이름이 똑같으면 안 된다.
5. meaning: 원래 한자의 뜻을 살린 한국어 한 문장(40자 이내). vibe: 이 이름을 가진 일본 사람의 재미있는 캐릭터 설정, 한국어 18자 이내. 특정 실존 인물·민족·외모 비하 금지.
6. 한자는 일본 신자체로 적는다(예: 眞→真). kr에는 한국 훈음(예: "참 진").

다른 말 없이 이 형태의 JSON만 출력:
{"surname":{"kanji":"河","kr":"물 하"},"given":[{"kanji":"憲","kr":"법 헌"},{"kanji":"津","kr":"나루 진"}],"names":[{"surname_kana":"かわ","surname_type":"훈독","given_parts":["けん","しん"],"given_type":"음독+음독","meaning":"...","vibe":"..."}],"note":""}
given_parts는 이름 글자 수와 같은 길이의 히라가나 배열. note에는 훈음이 애매해서 한자를 추측했을 때만 한국어로 짧게 적어.`;
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (_) {} }
  return null;
}

function validate(d, n) {
  if (!d || !Array.isArray(d.names)) return null;
  const names = d.names
    .filter((x) => x && KANA.test(x.surname_kana || "") && Array.isArray(x.given_parts) &&
      x.given_parts.length === n && x.given_parts.every((p) => KANA.test(p || "")))
    .slice(0, 3)
    .map((x) => ({
      surname_kana: x.surname_kana, surname_type: clean(x.surname_type, 12),
      given_parts: x.given_parts, given_type: clean(x.given_type, 20),
      meaning: clean(x.meaning, 80), vibe: clean(x.vibe, 40),
    }));
  if (!names.length) return null;
  const k = (o) => (o && HAN.test(o.kanji || "") ? { kanji: [...o.kanji][0], kr: clean(o.kr, 12) } : null);
  return {
    surname: k(d.surname),
    given: Array.isArray(d.given) ? d.given.slice(0, n).map(k) : [],
    names,
    note: clean(d.note, 80),
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }

  const sur = part(body.sur);
  const giv = (Array.isArray(body.giv) ? body.giv : []).slice(0, 2).map(part).filter(Boolean);
  if (!sur || !giv.length) return json({ error: "bad_request" }, 400);

  const kv = env.NAMES;
  const key = "v1:" + [sur, ...giv].map((x) => x.kanji || "raw:" + x.raw).join("|");

  // 1) 캐시: 같은 한자 조합은 AI를 다시 부르지 않음 (비용 절감의 핵심)
  //    무료 플랜: Cloudflare Cache API 사용 (쓰기 횟수 제한 없음, 데이터센터별 캐시)
  //    유료 플랜: KV(NAMES)를 연결하면 전 세계 공용 캐시 + 속도 제한 + 하루 한도까지 사용
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheReq = new Request("https://cache.jp-name.internal/" + encodeURIComponent(key));
  try {
    if (cache) {
      const c = await cache.match(cacheReq);
      if (c) return json({ ...(await c.json()), cached: true });
    }
    if (kv) {
      const hit = await kv.get(key, "json");
      if (hit) return json({ ...hit, cached: true });
    }
  } catch (_) {}

  if (kv) {
    try {
      // 2) IP별 속도 제한
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const rk = `rl:${ip}:${Math.floor(Date.now() / 600000)}`;
      const usedIp = Number((await kv.get(rk)) || 0);
      if (usedIp >= Number(env.IP_LIMIT_PER_10MIN || 20)) return json({ error: "rate_limited", fallback: true }, 429);

      // 3) 하루 예산: 넘으면 사전 모드로
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST
      const bk = `budget:${day}`;
      const usedDay = Number((await kv.get(bk)) || 0);
      if (usedDay >= Number(env.DAILY_CALL_LIMIT || 30000)) return json({ error: "budget", fallback: true }, 503);

      await kv.put(rk, String(usedIp + 1), { expirationTtl: 900 });
      await kv.put(bk, String(usedDay + 1), { expirationTtl: 172800 });
    } catch (_) {
      // KV 한도 초과 등으로 실패해도 이름 짓기는 계속
    }
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: "not_configured", fallback: true }, 503);

  // 4) Claude 호출
  let text = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || "claude-haiku-5-5",
        max_tokens: 900,
        messages: [{ role: "user", content: buildPrompt(sur, giv) }],
      }),
    });
    if (!r.ok) return json({ error: "upstream", status: r.status, fallback: true }, 502);
    const data = await r.json();
    text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (_) {
    return json({ error: "upstream", fallback: true }, 502);
  }

  const result = validate(parseJSON(text), giv.length);
  if (!result) return json({ error: "invalid", fallback: true }, 502);

  try {
    if (cache) {
      await cache.put(cacheReq, new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" },
      }));
    }
    if (kv) await kv.put(key, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (_) {}
  return json({ ...result, cached: false });
}

export function onRequest() {
  return json({ error: "method_not_allowed" }, 405);
}
