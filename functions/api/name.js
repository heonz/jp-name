// POST /api/name
// 입력: { sur: {kanji, kr, raw}, giv: [{kanji, kr, raw}, ...] }
// 입력(선택): fresh: true 이면 저장된 결과를 쓰지 않고 새로 지음, exclude: ["かわ|けんしん", ...] 피할 읽기
// 순우리말 이름: { mode: "native", sur: {...}, native: { name: "예솔", meaning: "예쁜 소나무" } }
//   → 이름의 뜻을 한자로 옮긴 일본 이름. names[].given_kanji 에 이름별 한자가 들어 있음
// 출력: { surname, given, names: [...3개], note, cached }
//
// 필요한 설정 (Cloudflare Worker > Settings > Variables and Secrets)
//   Secret   ANTHROPIC_API_KEY   : Anthropic API 키
//   Variable MODEL               : 기본 claude-haiku-5-5
//   (선택) KV binding NAMES      : 유료 플랜용. 연결하면 공용 캐시 + 속도 제한 + 하루 한도 사용
//   Variable DAILY_CALL_LIMIT    : KV 연결 시 하루 최대 AI 호출 수 (기본 30000)
//   Variable IP_LIMIT_PER_10MIN  : KV 연결 시 IP 하나당 10분 최대 요청 수 (기본 20)
// KV 없이도 동작해요(무료 플랜). 이때 비용 상한은 Anthropic 콘솔의 월 사용 한도로 지켜요.
//
// 실패 원인은 Cloudflare 대시보드 > Worker > Logs 에 "[name]" 으로 남아요.

const HAN = /\p{Script=Han}/u;
const KANA = /^[ぁ-ゖー]+$/;
const CACHE_VERSION = "v6";
const HAN_CHUNK = /^[\p{Script=Han}々]{1,3}$/u;
const HANGUL_NAME = /^[가-힣\p{Script=Han}]{1,5}$/u;
// 같은 한자 조합에 대해 서로 다른 결과를 몇 개까지 모아둘지.
// 이 개수가 찰 때까지는 매번 새로 지어서(동명이인도 다른 이름), 다 차면 그중 하나를 무작위로 보여줘요.
const VARIANTS = 4;
const MAX_STORED = 8;

function clean(s, max = 20) {
  return String(s ?? "").replace(/[\u0000-\u001f<>{}`$\\"]/g, "").trim().slice(0, max);
}

// 가타카나→히라가나, 공백·가운뎃점 제거
function kana(s) {
  return String(s ?? "")
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・·\.\-_/、,]/g, "");
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

function buildPrompt(sur, giv, avoid, gender) {
  const desc = (x) =>
    x.kanji ? `${x.kanji}${x.kr ? ` (${x.kr})` : ""}` : `"${x.raw}" (한국어 훈음 설명. 인명용 한자 하나로 확정할 것)`;
  return `너는 한국 사람 이름의 한자를 일본식으로 읽어서 '재미로' 일본 이름을 지어주는 작명가야.

입력
- 성: ${desc(sur)}
- 이름 글자(순서대로, ${giv.length}글자): ${giv.map(desc).join(" / ")}
- 성별: ${gender === "m" ? "남자" : gender === "f" ? "여자" : "정하지 않음"}

규칙
1. 성은 한자 한 글자를 그대로 유지하고, 일본어로 읽는 방법만 고른다. 글자를 덧붙이거나 바꾸지 마.
   성 읽기 규칙: 성에 훈독(뜻으로 읽는 일본어)이 있으면 1순위 이름의 성은 반드시 훈독으로 읽는다. 음독은 '리', '보쿠'처럼 외국 이름처럼 들려서 재미가 없기 때문이다. 훈독 예: 李→すもも, 朴→ほお, 金→かね, 林→はやし, 河→かわ, 申→さる, 韓→から, 洪→おおみず, 姜→はじかみ, 徐→おもむろ, 柳→やなぎ, 南→みなみ, 高→たか, 白→しろ, 文→ふみ, 孫→まご, 車→くるま, 池→いけ, 石→いし. 2·3순위는 다른 훈독이나 음독을 섞어도 된다. 崔·鄭·趙·宋·裵·曺·劉·盧·禹·閔·蔡처럼 훈독이 없는 성만 음독으로 읽는다.
2. 이름은 원래 한자를 원래 순서대로 쓰고, 각 글자를 음독·훈독·이름용 읽기(名乗り) 중 하나로 읽는다.
3. 그 한자에 실제로 있는 읽기만 사용한다. 흔하지 않은 한자라도 음독은 반드시 있으니 음독을 쓰면 된다. 절대 포기하지 말고 항상 3개를 채운다.
4. 가장 중요: 실제 일본 사람이 쓸 법한, 멋지고 자연스러운 이름. 훈독과 이름용 읽기(名乗り)를 적극적으로 쓴다.
   - 좋은 예: 智英→ともひで, 敏智→としとも, 秀真→ひでま, 民智→たみとも, 恵真→えま, 憲津→のりつ보다 けんしん처럼 실제로 흔한 소리
   - 음독+음독(예: みんち, りゅうしん)은 그 소리가 실제 일본 이름으로 흔할 때만 쓴다. 어색한 음독 나열은 피한다.
   - 3개 중 최소 2개는 이름에 훈독이나 이름용 읽기가 들어가게 한다.
   - 세 이름의 읽기는 서로 달라야 하고, 가장 일본 이름다운 것을 1순위로 둔다.
${gender === "m" ? "   - 남자 이름이어야 한다. 일본 남자 이름에 흔한 읽기와 끝소리(예: ~と, ~き, ~や, ~た, ~すけ, ~ひこ, ~お, ~ひろ, けん·しん·しゅん 등)를 쓰고, 여자 이름처럼 들리는 ~こ·~み·~え·~か·~な는 피한다. 캐릭터 설정도 남자로.\n" : ""}${gender === "f" ? "   - 여자 이름이어야 한다. 일본 여자 이름에 흔한 읽기와 끝소리(예: ~こ, ~み, ~え, ~か, ~な, ~ほ, ~り, ~の, めぐみ·かおり·あや 등)를 쓰고, 남자 이름처럼 들리는 ~お·~すけ·~ひこ·~ろう·けん 같은 소리는 피한다. 캐릭터 설정도 여자로.\n" : ""}
5. given_parts는 이름 글자마다 하나씩, 정확히 ${giv.length}개의 히라가나 문자열. 두 글자 읽기를 하나로 합치지 마.
6. meaning: 원래 한자의 뜻을 살린 한국어 한 문장(40자 이내). vibe: 이 이름을 가진 일본 사람의 재미있는 캐릭터 설정, 한국어 18자 이내. 실존 인물·민족·외모 비하 금지.
7. 한자는 일본 신자체로 적는다(예: 眞→真). kr에는 한국 훈음(예: "참 진").
8. note에는 훈음이 애매해서 한자를 추측했을 때만 한국어로 짧게 적는다.

${avoid && avoid.length ? `9. 다음 조합은 이미 보여준 것이라 되도록 피하고 다른 읽기·다른 캐릭터 설정을 써: ${avoid.join(", ")}
` : ""}
give_names 도구로 답해.`;
}

function genderRule(gender) {
  if (gender === "m") return "   - 남자 이름이어야 한다. 일본 남자 이름에 흔한 끝소리(~と, ~き, ~や, ~た, ~すけ, ~ひこ, ~お, ~ひろ 등)를 쓰고 여자 이름처럼 들리는 소리는 피한다. 캐릭터 설정도 남자로.\n";
  if (gender === "f") return "   - 여자 이름이어야 한다. 일본 여자 이름에 흔한 끝소리(~こ, ~み, ~え, ~か, ~な, ~ほ, ~り, ~の 등)를 쓰고 남자 이름처럼 들리는 소리는 피한다. 캐릭터 설정도 여자로.\n";
  return "";
}

function buildNativePrompt(sur, nat, avoid, gender) {
  const surDesc = sur.kanji ? `${sur.kanji}${sur.kr ? ` (${sur.kr})` : ""}` : `"${sur.raw}" (한국어 훈음 설명. 인명용 한자 하나로 확정할 것)`;
  return `너는 한국 사람의 순우리말(한자가 없는) 이름을 '재미로' 일본 이름으로 바꿔 주는 작명가야.

입력
- 성: ${surDesc}
- 이름(순우리말, 한글): ${nat.name}
- 이름 뜻(사용자 설명, 비어 있을 수 있음): ${nat.meaning || "(없음)"}
${nat.fixed.length ? `- 한자가 있는 글자: ${nat.fixed.map((f) => `'${f.syl}' = ${f.kanji}${f.kr ? `(${f.kr})` : ""}`).join(", ")}. 이 글자는 반드시 그 한자를 그대로 쓰고 일본식 읽기(음독·훈독·이름용 읽기)만 고른다. 나머지 글자만 순우리말이니 뜻을 살린 한자를 고른다. 원래 이름의 글자 순서를 지킨다(예: 은샘 → 恩 + 泉).\n` : ""}
- 성별: ${gender === "m" ? "남자" : gender === "f" ? "여자" : "정하지 않음"}

규칙
1. 성은 한자 한 글자를 그대로 유지하고, 일본어로 읽는 방법만 고른다.
   성 읽기 규칙: 성에 훈독(뜻으로 읽는 일본어)이 있으면 1순위 이름의 성은 반드시 훈독으로 읽는다. 음독은 '리', '보쿠'처럼 외국 이름처럼 들려서 재미가 없기 때문이다. 훈독 예: 李→すもも, 朴→ほお, 金→かね, 林→はやし, 河→かわ, 申→さる, 韓→から, 洪→おおみず, 姜→はじかみ, 徐→おもむろ, 柳→やなぎ, 南→みなみ, 高→たか, 白→しろ, 文→ふみ, 孫→まご, 車→くるま, 池→いけ, 石→いし. 2·3순위는 다른 훈독이나 음독을 섞어도 된다. 崔·鄭·趙·宋·裵·曺·劉·盧·禹·閔·蔡처럼 훈독이 없는 성만 음독으로 읽는다.
2. 이름은 순우리말의 뜻을 살려서, 그 뜻을 가진 한자를 골라 실제 일본 사람이 쓰는 자연스러운 이름으로 만든다.
   - 좋은 예: 하늘→空(そら), 나래→翼(つばさ), 샘→泉(いずみ), 보람→実(みのり), 다솜(사랑)→愛(あい), 한별→昴(すばる), 이슬→雫(しずく), 노을→茜(あかね), 바다→海斗(かいと)
   - 여러 말이 합쳐진 이름(예: 은샘=은+샘, 예솔=예쁜+솔)은 각 부분의 뜻을 살려 한자 1~2글자로 옮긴다.
   - 사용자가 뜻을 적었으면 그 뜻을 따른다. 뜻을 모르면 가장 그럴듯한 뜻으로 풀고, 어떻게 풀었는지 note에 한국어로 짧게 적는다.
3. 3개 중 1개는 원래 이름과 소리가 비슷한 일본 이름이어도 좋다(예: 하나→花(はな), 아라→亜良(あら)). 그 경우 given_type을 "소리 비슷"으로, 나머지는 "뜻 옮김"으로.
4. 한자는 일본 이름에 실제로 쓰는 글자로 1~2글자(숙자훈 포함 최대 3글자). 그 한자에 있는 읽기만 쓴다. 세 이름은 서로 달라야 한다.
${genderRule(gender)}5. given_kanji와 given_parts는 같은 길이의 배열: 한자 덩어리마다 그 읽기(히라가나). 예: 空→["空"],["そら"] / 海斗→["海","斗"],["かい","と"] / 雲雀(숙자훈)→["雲雀"],["ひばり"]
6. meaning: 우리말 뜻과 고른 한자를 연결해 설명하는 한국어 한 문장(40자 이내). vibe: 이 이름을 가진 일본 사람의 재미있는 캐릭터 설정, 한국어 18자 이내. 실존 인물·민족·외모 비하 금지.
${avoid && avoid.length ? `7. 다음 조합은 이미 보여준 것이라 되도록 피하고 다른 한자·다른 캐릭터 설정을 써: ${avoid.join(", ")}\n` : ""}
give_names 도구로 답해.`;
}

function nativeToolSchema() {
  return {
    name: "give_names",
    description: "순우리말 이름의 뜻을 한자로 옮긴 일본 이름 3개를 돌려준다.",
    input_schema: {
      type: "object",
      properties: {
        surname: { type: "object", properties: { kanji: { type: "string" }, kr: { type: "string" } }, required: ["kanji", "kr"] },
        names: {
          type: "array", minItems: 3, maxItems: 3,
          items: {
            type: "object",
            properties: {
              surname_kana: { type: "string", description: "성의 히라가나 읽기" },
              surname_type: { type: "string", description: "음독 / 훈독" },
              given_kanji: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "이름 한자 덩어리" },
              given_parts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "덩어리별 히라가나 읽기" },
              given_type: { type: "string", description: "뜻 옮김 / 소리 비슷" },
              meaning: { type: "string" },
              vibe: { type: "string" },
            },
            required: ["surname_kana", "surname_type", "given_kanji", "given_parts", "given_type", "meaning", "vibe"],
          },
        },
        note: { type: "string" },
      },
      required: ["surname", "names"],
    },
  };
}

function validateNative(d, fixed) {
  if (!d || !Array.isArray(d.names)) return { result: null, why: "no_names" };
  const reasons = [];
  const seen = new Set();
  const names = [];
  for (const x of d.names) {
    if (!x) continue;
    const sk = kana(x.surname_kana);
    const gk = (Array.isArray(x.given_kanji) ? x.given_kanji : typeof x.given_kanji === "string" ? [x.given_kanji] : [])
      .map((k) => String(k ?? "").replace(/\s/g, "")).filter(Boolean);
    let parts = (Array.isArray(x.given_parts) ? x.given_parts : typeof x.given_parts === "string" ? [x.given_parts] : [])
      .map(kana).filter(Boolean);
    if (gk.length === 1 && parts.length > 1) parts = [parts.join("")];
    if (!KANA.test(sk)) { reasons.push("surname_kana:" + x.surname_kana); continue; }
    if (!gk.length || gk.length > 3 || !gk.every((k) => HAN_CHUNK.test(k))) { reasons.push("given_kanji:" + JSON.stringify(x.given_kanji)); continue; }
    if (parts.length !== gk.length || !parts.every((p) => KANA.test(p))) { reasons.push("given_parts:" + JSON.stringify(x.given_parts)); continue; }
    if (fixed && fixed.some((f) => !gk.join("").includes(f.kanji))) { reasons.push("missing_fixed:" + gk.join("")); continue; }
    const k = sk + "|" + gk.join("") + "|" + parts.join("");
    if (seen.has(k)) continue;
    seen.add(k);
    names.push({
      surname_kana: sk, surname_type: clean(x.surname_type, 12),
      given_kanji: gk, given_parts: parts, given_type: clean(x.given_type, 20),
      meaning: clean(x.meaning, 80), vibe: clean(x.vibe, 40),
    });
    if (names.length === 3) break;
  }
  if (!names.length) return { result: null, why: reasons.join(" ; ") || "empty" };
  const s = d.surname && HAN.test(d.surname.kanji || "") ? { kanji: [...d.surname.kanji][0], kr: clean(d.surname.kr, 12) } : null;
  return { result: { surname: s, given: [], names, note: clean(d.note, 80) }, why: reasons.join(" ; ") };
}

function toolSchema(n) {
  const kanjiObj = {
    type: "object",
    properties: { kanji: { type: "string" }, kr: { type: "string" } },
    required: ["kanji", "kr"],
  };
  return {
    name: "give_names",
    description: "한국 이름 한자를 일본식으로 읽은 이름 3개를 돌려준다.",
    input_schema: {
      type: "object",
      properties: {
        surname: kanjiObj,
        given: { type: "array", items: kanjiObj, minItems: n, maxItems: n },
        names: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              surname_kana: { type: "string", description: "성의 히라가나 읽기" },
              surname_type: { type: "string", description: "음독 / 훈독 / 이름읽기" },
              given_parts: {
                type: "array",
                items: { type: "string" },
                minItems: n,
                maxItems: n,
                description: "이름 글자별 히라가나 읽기",
              },
              given_type: { type: "string", description: "예: 음독+훈독" },
              meaning: { type: "string" },
              vibe: { type: "string" },
            },
            required: ["surname_kana", "surname_type", "given_parts", "given_type", "meaning", "vibe"],
          },
        },
        note: { type: "string" },
      },
      required: ["surname", "given", "names"],
    },
  };
}

function validate(d, n) {
  if (!d || !Array.isArray(d.names)) return { result: null, why: "no_names" };
  const reasons = [];
  const seen = new Set();
  const names = [];
  for (const x of d.names) {
    if (!x) continue;
    const sk = kana(x.surname_kana);
    let parts = Array.isArray(x.given_parts) ? x.given_parts.map(kana).filter(Boolean)
      : typeof x.given_parts === "string" ? [kana(x.given_parts)] : [];
    if (n === 1 && parts.length > 1) parts = [parts.join("")];
    if (!KANA.test(sk)) { reasons.push("surname_kana:" + x.surname_kana); continue; }
    if (parts.length !== n || !parts.every((p) => KANA.test(p))) { reasons.push("given_parts:" + JSON.stringify(x.given_parts)); continue; }
    const k = sk + "|" + parts.join("");
    if (seen.has(k)) continue;
    seen.add(k);
    names.push({
      surname_kana: sk, surname_type: clean(x.surname_type, 12),
      given_parts: parts, given_type: clean(x.given_type, 20),
      meaning: clean(x.meaning, 80), vibe: clean(x.vibe, 40),
    });
    if (names.length === 3) break;
  }
  if (!names.length) return { result: null, why: reasons.join(" ; ") || "empty" };
  const k = (o) => (o && HAN.test(o.kanji || "") ? { kanji: [...o.kanji][0], kr: clean(o.kr, 12) } : null);
  return {
    result: {
      surname: k(d.surname),
      given: Array.isArray(d.given) ? d.given.slice(0, n).map(k) : [],
      names,
      note: clean(d.note, 80),
    },
    why: reasons.join(" ; "),
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "bad_request" }, 400); }

  const sur = part(body.sur);
  const native = body.mode === "native";
  const nat = native && body.native && typeof body.native === "object"
    ? {
      name: clean(body.native.name, 6).replace(/\s/g, ""),
      meaning: clean(body.native.meaning, 30),
      // 한자가 있는 글자 (예: 은샘의 '은' = 恩). 이 글자는 한자를 그대로 쓰고 읽기만 고름
      fixed: (Array.isArray(body.native.fixed) ? body.native.fixed : []).slice(0, 2)
        .map((f) => ({ syl: clean(f && f.syl, 2), kanji: [...clean(f && f.kanji, 2)][0] || "", kr: clean(f && f.kr, 12) }))
        .filter((f) => HAN.test(f.kanji)),
    } : null;
  const giv = native ? [] : (Array.isArray(body.giv) ? body.giv : []).slice(0, 2).map(part).filter(Boolean);
  if (!sur) return json({ error: "bad_request" }, 400);
  if (native ? !(nat && HANGUL_NAME.test(nat.name)) : !giv.length) return json({ error: "bad_request" }, 400);
  const n = giv.length;
  const label = (sur.kanji || sur.raw) + (native ? nat.name : giv.map((x) => x.kanji || x.raw).join(""));

  const kv = env.NAMES;
  const gkey = ["m", "f"].includes(body.gender) ? body.gender : "n";
  const key = CACHE_VERSION + ":" + gkey + ":" + (native
    ? "native:" + (sur.kanji || "raw:" + sur.raw) + "|" + nat.name + "|" + nat.meaning + "|" + nat.fixed.map((f) => f.kanji).join("")
    : [sur, ...giv].map((x) => x.kanji || "raw:" + x.raw).join("|"));
  const nameKey = (x) => x.surname_kana + "|" + (x.given_kanji ? x.given_kanji.join("") + "|" : "") + x.given_parts.join("");

  const fresh = body.fresh === true;
  const gender = body.gender === "m" || body.gender === "f" ? body.gender : "";
  const exclude = (Array.isArray(body.exclude) ? body.exclude : []).slice(0, 12).map((x) => clean(x, 30)).filter(Boolean);

  // 1) 저장된 결과들: 같은 한자 조합이어도 여러 버전을 모아두고 골고루 보여줌
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheReq = new Request("https://cache.jp-name.internal/" + encodeURIComponent(key));
  let stored = { variants: [] };
  try {
    let hit = null;
    if (cache) { const c = await cache.match(cacheReq); if (c) hit = await c.json(); }
    if (!hit && kv) hit = await kv.get(key, "json");
    if (hit && Array.isArray(hit.variants)) stored = hit;
  } catch (_) {}
  if (!fresh && stored.variants.length >= VARIANTS) {
    const pick = stored.variants[Math.floor(Math.random() * stored.variants.length)];
    return json({ ...pick, cached: true });
  }
  const avoid = [...new Set([
    ...exclude,
    ...stored.variants.flatMap((v) => v.names.map((x) => x.surname_kana + "|" + (x.given_kanji ? x.given_kanji.join("") + "|" : "") + x.given_parts.join(""))),
  ])].slice(0, 15);

  if (kv) {
    try {
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const rk = `rl:${ip}:${Math.floor(Date.now() / 600000)}`;
      const usedIp = Number((await kv.get(rk)) || 0);
      if (usedIp >= Number(env.IP_LIMIT_PER_10MIN || 20)) return json({ error: "rate_limited", fallback: true }, 429);
      const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const bk = `budget:${day}`;
      const usedDay = Number((await kv.get(bk)) || 0);
      if (usedDay >= Number(env.DAILY_CALL_LIMIT || 30000)) return json({ error: "budget", fallback: true }, 503);
      await kv.put(rk, String(usedIp + 1), { expirationTtl: 900 });
      await kv.put(bk, String(usedDay + 1), { expirationTtl: 172800 });
    } catch (_) {}
  }

  if (!env.ANTHROPIC_API_KEY) {
    console.log("[name] no ANTHROPIC_API_KEY");
    return json({ error: "not_configured", fallback: true }, 503);
  }

  // 2) Claude 호출: give_names 도구로 답하게 강제해서 형식이 깨지지 않게 함
  const ask = async (prompt) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY.trim(),
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.MODEL || "claude-haiku-5-5",
          max_tokens: 1600,
          tools: [native ? nativeToolSchema() : toolSchema(n)],
          tool_choice: { type: "tool", name: "give_names" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const tu = (data.content || []).find((c) => c.type === "tool_use");
        if (!tu) console.log(`[name] ${label} no tool_use, stop_reason=${data.stop_reason}`);
        if (data.stop_reason === "max_tokens") console.log(`[name] ${label} hit max_tokens`);
        return tu ? tu.input : null;
      }
      const errText = await r.text().catch(() => "");
      console.log(`[name] ${label} upstream ${r.status} ${errText.slice(0, 300)}`);
      if (r.status === 429 || r.status >= 500) { await sleep(900); continue; }
      throw new Error("upstream " + r.status);
    }
    throw new Error("upstream retry exhausted");
  };

  let result = null;
  try {
    const prompt = () => native ? buildNativePrompt(sur, nat, avoid, gender) : buildPrompt(sur, giv, avoid, gender);
    const check = (d) => native ? validateNative(d, nat.fixed) : validate(d, n);
    for (let i = 0; i < 2 && !result; i++) {
      const v = check(await ask(prompt()));
      if (v.why) console.log(`[name] ${label} dropped: ${v.why}`);
      result = v.result;
    }
    if (result && result.names.length < 3) {
      const have = result.names.map(nameKey).join(", ");
      const v = check(await ask(prompt() +
        `\n\n이미 나온 이름: ${have}. 이것과 겹치지 않는 다른 조합을 더해서 names를 3개 채워.`));
      if (v.result) {
        const seen = new Set(result.names.map(nameKey));
        for (const x of v.result.names) {
          const k = nameKey(x);
          if (result.names.length < 3 && !seen.has(k)) { seen.add(k); result.names.push(x); }
        }
      }
    }
  } catch (e) {
    console.log(`[name] ${label} error ${e && e.message}`);
    return json({ error: "upstream", fallback: true }, 502);
  }
  if (!result) {
    console.log(`[name] ${label} invalid after retries`);
    return json({ error: "invalid", fallback: true }, 502);
  }
  if (result.names.length < 3) return json({ ...result, cached: false }); // 3개 미만은 캐시하지 않음

  try {
    stored.variants.push(result);
    if (stored.variants.length > MAX_STORED) stored.variants = stored.variants.slice(-MAX_STORED);
    const body = JSON.stringify(stored);
    if (cache) {
      await cache.put(cacheReq, new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=2592000" },
      }));
    }
    if (kv) await kv.put(key, body, { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (_) {}
  return json({ ...result, cached: false });
}

export function onRequest() {
  return json({ error: "method_not_allowed" }, 405);
}
