/* 한국 이름 → 가타카나 표기 (일본 식당 대기 명단·호텔 체크인에서 쓰는 표기)
   toKatakana('이민지', 1) → 'イ・ミンジ'   (두 번째 값은 성의 글자 수)
   규칙
   - 성의 첫소리 ㄱ·ㄷ·ㅂ·ㅈ 은 맑은 소리 (김 キム, 박 パク, 정 チョン)
   - 이름 첫 글자의 ㄷ·ㅂ·ㅈ 은 흐린 소리 (지민 ジミン, 도윤 ドユン, 보검 ボゴム)
   - 글자 사이의 ㄱ·ㄷ·ㅂ·ㅈ 은 받침이 ㄱ·ㅂ·ㅅ 류가 아니면 흐린 소리 (민준 ミンジュン, 박지 パクチ)
   - 받침: ㄱ→ク ㄴ·ㅇ→ン ㄹ→ル ㅁ→ム ㅂ→プ 나머지→ッ
   - 받침 + ㅇ으로 시작하는 글자는 이어서 읽음 (민우 ミヌ, 선영 ソニョン) */
(function (root) {
  var ROW = {
    k: ['カ', 'キ', 'ク', 'ケ', 'コ'], g: ['ガ', 'ギ', 'グ', 'ゲ', 'ゴ'],
    s: ['サ', 'シ', 'ス', 'セ', 'ソ'], j: ['ジャ', 'ジ', 'ジュ', 'ジェ', 'ジョ'],
    c: ['チャ', 'チ', 'チュ', 'チェ', 'チョ'], t: ['タ', 'ティ', 'トゥ', 'テ', 'ト'],
    d: ['ダ', 'ディ', 'ドゥ', 'デ', 'ド'], n: ['ナ', 'ニ', 'ヌ', 'ネ', 'ノ'],
    h: ['ハ', 'ヒ', 'フ', 'ヘ', 'ホ'], p: ['パ', 'ピ', 'プ', 'ペ', 'ポ'],
    b: ['バ', 'ビ', 'ブ', 'ベ', 'ボ'], m: ['マ', 'ミ', 'ム', 'メ', 'モ'],
    r: ['ラ', 'リ', 'ル', 'レ', 'ロ'], '': ['ア', 'イ', 'ウ', 'エ', 'オ']
  };
  // 요음 (ya/yu/yo)
  var Y = {
    k: ['キャ', 'キュ', 'キョ'], g: ['ギャ', 'ギュ', 'ギョ'], s: ['シャ', 'シュ', 'ショ'], j: ['ジャ', 'ジュ', 'ジョ'],
    c: ['チャ', 'チュ', 'チョ'], t: ['テャ', 'テュ', 'テョ'], d: ['デャ', 'デュ', 'デョ'], n: ['ニャ', 'ニュ', 'ニョ'],
    h: ['ヒャ', 'ヒュ', 'ヒョ'], p: ['ピャ', 'ピュ', 'ピョ'], b: ['ビャ', 'ビュ', 'ビョ'], m: ['ミャ', 'ミュ', 'ミョ'],
    r: ['リャ', 'リュ', 'リョ'], '': ['ヤ', 'ユ', 'ヨ']
  };
  var SMALL = { a: 'ァ', i: 'ィ', e: 'ェ', o: 'ォ' };
  // 초성 19자 → 맑은 소리 / 흐린 소리
  var L = [['k', 'g'], ['k', 'k'], ['n', 'n'], ['t', 'd'], ['t', 't'], ['r', 'r'], ['m', 'm'], ['p', 'b'], ['p', 'p'],
    ['s', 's'], ['s', 's'], ['', ''], ['c', 'j'], ['c', 'c'], ['c', 'c'], ['k', 'k'], ['t', 't'], ['p', 'p'], ['h', 'h']];
  // 중성 21자: [모음, 종류] 종류: 0 단모음, y 요음, w 이중모음
  var V = [['a', 0], ['e', 0], ['a', 'y'], ['e', 'y'], ['o', 0], ['e', 0], ['o', 'y'], ['e', 'y'], ['o', 0], ['a', 'w'], ['e', 'w'],
    ['e', 'w'], ['o', 'y'], ['u', 0], ['o', 'w'], ['e', 'w'], ['i', 'w'], ['u', 'y'], ['u', 0], ['i', 'w'], ['i', 0]];
  var VI = { a: 0, i: 1, u: 2, e: 3, o: 4 };
  // 받침 28자 → 표기
  var T = ['', 'ク', 'ク', 'ク', 'ン', 'ン', 'ン', 'ッ', 'ル', 'ク', 'ム', 'ル', 'ル', 'ル', 'プ', 'ル', 'ム', 'プ', 'プ', 'ッ', 'ッ', 'ン', 'ッ', 'ッ', 'ク', 'ッ', 'プ', 'ッ'];
  // 받침이 다음 글자로 넘어갈 때의 자음 (이어 읽기)
  var CARRY = { 1: 'g', 4: 'n', 8: 'r', 16: 'm', 17: 'b' };
  var VOICELESS_AFTER = { 1: 1, 2: 1, 3: 1, 7: 1, 17: 1, 18: 1, 19: 1, 20: 1, 22: 1, 23: 1, 24: 1, 25: 1, 26: 1 };

  function syl(cons, vi) {
    var v = V[vi][0], kind = V[vi][1];
    if (kind === 'y') {
      if (v === 'e') return cons === '' ? 'イェ' : ROW[cons][3];          // 계→ケ, 예→イェ
      var yi = v === 'a' ? 0 : v === 'u' ? 1 : 2;
      return Y[cons][yi];
    }
    if (kind === 'w') {
      if (vi === 19) return cons === '' ? 'ウィ' : ROW[cons][1];          // 의→ウィ, 희→ヒ
      if (cons === '') return { a: 'ワ', e: 'ウェ', i: 'ウィ', o: 'ウォ' }[v];
      if (v === 'e' && (cons === 'c' || cons === 'j' || cons === 's')) return ROW[cons][3]; // 최→チェ, 쇠→セ
      var base = cons === 'h' ? 'フ' : ROW[cons][2];                      // 과→クァ, 화→ファ
      return base + SMALL[v];
    }
    if (cons === 's' && v === 'i') return 'シ';
    return ROW[cons][VI[v]];
  }

  function toKatakana(name, surLen) {
    var chars = Array.from(String(name || '').replace(/\s/g, ''));
    surLen = surLen || 1;
    var out = [], prevT = -1, carry = null;
    for (var idx = 0; idx < chars.length; idx++) {
      var code = chars[idx].charCodeAt(0) - 0xAC00;
      if (code < 0 || code > 11171) { out.push(chars[idx]); prevT = -1; carry = null; continue; }
      var l = Math.floor(code / 588), vi = Math.floor((code % 588) / 28), t = code % 28;
      var wordStart = idx === 0 || idx === surLen;
      var cons;
      if (l === 11 && carry !== null && !wordStart) cons = carry;          // 이어 읽기
      else if (idx === 0) cons = L[l][0];                                  // 성 첫소리: 맑은 소리
      else if (idx === surLen) cons = (l === 0 || l === 1) ? 'k' : L[l][1]; // 이름 첫소리: ㄷㅂㅈ 흐린 소리
      else cons = VOICELESS_AFTER[prevT] ? L[l][0] : L[l][1];
      var s = syl(cons, vi);
      // 다음 글자가 ㅇ으로 시작하면 받침을 넘겨 줌
      var next = chars[idx + 1] ? chars[idx + 1].charCodeAt(0) - 0xAC00 : -1;
      var nextNull = next >= 0 && next <= 11171 && Math.floor(next / 588) === 11 && idx + 1 !== surLen;
      if (t && nextNull && CARRY[t]) { carry = CARRY[t]; prevT = 0; }
      else { s += T[t]; carry = null; prevT = t; }
      if (idx === surLen && idx > 0) out.push('・');
      out.push(s);
    }
    return out.join('');
  }

  root.toKatakana = toKatakana;
  if (typeof module !== 'undefined') module.exports = { toKatakana: toKatakana };
})(typeof window !== 'undefined' ? window : globalThis);
