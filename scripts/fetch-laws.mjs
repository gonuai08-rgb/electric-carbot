#!/usr/bin/env node
/**
 * law.go.kr(국가법령정보센터) Open API(DRF)에서 전기차 민원 근거 법령을 미리 받아
 *   public/data/laws.json  및  data/laws.json  으로 저장한다.
 *
 * - GitHub Actions(.github/workflows/fetch-laws.yml)에서 주기적으로 실행된다.
 * - 로컬 실행:  node scripts/fetch-laws.mjs
 * - OC 키 우선순위:  환경변수 LAW_OC  >  laws.config.json 의 "oc"  >  "test"
 *   (실사용 시 https://open.law.go.kr 에서 무료 발급 후 저장소 Secret(LAW_OC)에 등록 권장)
 *
 * 이 스크립트가 만드는 JSON은 "빌드 시점"에 1회 수집된 정적 파일이다.
 * 웹페이지는 이 파일을 같은 도메인에서 읽을 뿐, 실행 중 외부 API를 호출하지 않는다.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CONFIG_PATH = resolve(HERE, 'laws.config.json');
const OUT_PATHS = [
  resolve(ROOT, 'public/data/laws.json'),
  resolve(ROOT, 'data/laws.json'),
];

const BASE = 'https://www.law.go.kr/DRF';
const SITE = 'https://www.law.go.kr';
const UA = 'busan-ev-complaint-helper/1.0 (law prefetch via GitHub Actions)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const noSpace = (s) => String(s ?? '').replace(/\s/g, '');
const intOf = (s) => {
  const n = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};

function stripTags(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 별표내용은 원래 줄바꿈이 ", " 로 치환되어 오고 칸 정렬용 공백이 많다.
// PDF(별표 원문)가 정본이므로 여기서는 텍스트를 대략만 정리한다.
function tidyAttachmentText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?, ?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 자치법규 조내용은 항·호가 한 문자열에 붙어 오므로 가독성만 살짝 보정한다.
function tidyOrdinText(s) {
  return stripTags(s)
    .replace(/([^\n])\s*(①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|⑪|⑫|⑬|⑭|⑮)/g, '$1\n$2')
    // 호 목록(예: "말한다.2. ...") 앞에서 줄바꿈. 뒤에 한글/따옴표가 오는 경우만.
    .replace(/([^\d\n])\s*(\d{1,2}\.)\s*(?=[“"‘'「가-힣])/g, '$1\n$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getJson(url, tries = 4) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://www.law.go.kr/' },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`JSON 아님 — ${text.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
      if (i < tries) {
        const wait = 1500 * i;
        console.warn(`    재시도 ${i}/${tries - 1} (${e.message?.split('\n')[0]}) — ${wait}ms 대기`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------- 검색 */

async function searchLaw(oc, target, name) {
  const url =
    `${BASE}/lawSearch.do?OC=${encodeURIComponent(oc)}` +
    `&target=${target}&type=JSON&display=40&query=${encodeURIComponent(name)}`;
  const data = await getJson(url);
  const root = data.LawSearch ?? data.OrdinSearch ?? {};
  const items = asArray(root.law ?? root.ordin);
  if (items.length === 0) throw new Error(`검색 결과 없음: "${name}"`);
  const getName = (it) =>
    it['법령명한글'] ?? it['자치법규명'] ?? it['법령명'] ?? it['title'] ?? '';
  const exact = items.find((it) => noSpace(getName(it)) === noSpace(name));
  const chosen = exact ?? items[0];
  const mst =
    chosen['법령일련번호'] ??
    chosen['자치법규일련번호'] ??
    chosen['MST'] ??
    chosen['id'];
  if (!mst) throw new Error(`일련번호(MST) 없음: "${name}"`);
  return { mst: String(mst), matchedName: getName(chosen), exact: Boolean(exact) };
}

/* ---------------------------------------------------------------- 본문 */

async function fetchBody(oc, target, mst) {
  const url =
    `${BASE}/lawService.do?OC=${encodeURIComponent(oc)}` +
    `&target=${target}&type=JSON&MST=${encodeURIComponent(mst)}`;
  const data = await getJson(url);
  return data['법령'] ?? data['LawService'] ?? data;
}

/* ---- 법령(law): 조문단위 / 별표단위 ---- */

function lawArticleKey(u) {
  const n = intOf(u['조문번호']);
  const b = intOf(u['조문가지번호']);
  return b ? `${n}-${b}` : `${n}`;
}
function lawArticleLabel(u) {
  const n = intOf(u['조문번호']);
  const b = intOf(u['조문가지번호']);
  return b ? `제${n}조의${b}` : `제${n}조`;
}
function flattenLawArticle(u) {
  const lines = [];
  const head = stripTags(u['조문내용']);
  if (head) lines.push(head);
  for (const hang of asArray(u['항'])) {
    const h = stripTags(hang['항내용']);
    if (h) lines.push(h);
    for (const ho of asArray(hang['호'])) {
      const ht = stripTags(ho['호내용']);
      if (ht) lines.push('  ' + ht);
      for (const mok of asArray(ho['목'])) {
        const mt = stripTags(mok['목내용']);
        if (mt) lines.push('    ' + mt);
      }
    }
  }
  return lines.join('\n').trim();
}

function extractLaw(body, entry) {
  const info = body['기본정보'] ?? {};
  const units = asArray((body['조문'] ?? {})['조문단위'] ?? body['조문']);
  const all = units
    .filter((u) => u && (u['조문여부'] === '조문' || u['조문내용'] || u['항']))
    .map((u) => ({
      no: lawArticleLabel(u),
      key: lawArticleKey(u),
      title: stripTags(u['조문제목'] ?? ''),
      text: flattenLawArticle(u),
    }))
    .filter((a) => a.text);

  const articles = filterByKeys(all, entry.articles);
  const attachments = pickAttachments(body, entry.attachments);

  return {
    meta: {
      lawId: info['법령ID'] || '',
      promulgationDate: info['공포일자'] || '',
      enforceDate: info['시행일자'] || '',
      ministry:
        (info['소관부처'] && (info['소관부처'].content || info['소관부처'])) ||
        info['소관부처명'] ||
        '',
    },
    articles,
    attachments,
  };
}

function pickAttachments(body, wanted) {
  if (!wanted || wanted.length === 0) return [];
  const units = asArray((body['별표'] ?? {})['별표단위'] ?? body['별표']);
  const want = new Set(wanted.map(String));
  return units
    .filter((b) => (b['별표구분'] ?? '별표') === '별표')
    .map((b) => {
      const n = intOf(b['별표번호']);
      const g = intOf(b['별표가지번호']);
      const key = g ? `${n}-${g}` : `${n}`;
      const link = b['별표서식PDF파일링크'] || b['별표서식파일링크'] || b['별표HWP파일링크'] || '';
      return {
        key,
        no: g ? `별표 ${n}의${g}` : `별표 ${n}`,
        title: stripTags(b['별표제목'] ?? ''),
        text: tidyAttachmentText(b['별표내용'] ?? ''),
        pdf: link ? (link.startsWith('http') ? link : SITE + link) : '',
      };
    })
    .filter((b) => want.has(b.key));
}

/* ---- 자치법규(ordin): 조문.조 ---- */

function extractOrdin(body, entry) {
  const info = body['자치법규기본정보'] ?? {};
  const units = asArray((body['조문'] ?? {})['조'] ?? body['조문']);
  const all = units
    .filter((u) => u && u['조내용'])
    .map((u) => {
      const numRaw = String(asArray(u['조문번호'])[0] ?? '').padStart(6, '0');
      const n = intOf(numRaw.slice(0, 4));
      const b = intOf(numRaw.slice(4, 6));
      return {
        no: b ? `제${n}조의${b}` : `제${n}조`,
        key: b ? `${n}-${b}` : `${n}`,
        title: stripTags(u['조제목'] ?? ''),
        text: tidyOrdinText(u['조내용']),
      };
    })
    .filter((a) => a.text);

  return {
    meta: {
      lawId: info['자치법규ID'] || '',
      promulgationDate: info['공포일자'] || '',
      enforceDate: info['시행일자'] || '',
      ministry: info['지자체기관명'] || '',
      department: info['담당부서명'] || '',
      phone: info['전화번호'] || '',
    },
    articles: filterByKeys(all, entry.articles),
    attachments: [],
  };
}

function filterByKeys(all, wanted) {
  if (!wanted || wanted.length === 0) return all;
  const want = new Set(wanted.map(String));
  const hit = all.filter((a) => want.has(a.key));
  return hit.length ? hit : all.filter((a) => wanted.some((w) => a.key === String(w) || a.key.startsWith(String(w) + '-')));
}

/* ---------------------------------------------------------------- main */

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const oc = process.env.LAW_OC || cfg.oc || 'test';
  const usingTestKey = oc === 'test';
  console.log(`OC 키: ${usingTestKey ? 'test (공용)' : '전용'}\n`);

  const laws = [];
  const warnings = [];

  for (const entry of cfg.laws) {
    const target = entry.target || 'law';
    try {
      const { mst, matchedName, exact } = await searchLaw(oc, target, entry.name);
      if (!exact) warnings.push(`명칭 불일치: 요청 "${entry.name}" → 매칭 "${matchedName}"`);
      await sleep(400);

      const body = await fetchBody(oc, target, mst);
      const { meta, articles, attachments } =
        target === 'ordin' ? extractOrdin(body, entry) : extractLaw(body, entry);

      if (entry.articles && entry.articles.length && articles.length < entry.articles.length) {
        warnings.push(
          `"${matchedName}" 조문 일부 미확인 (요청 ${entry.articles.join(', ')} / 수집 ${articles.map((a) => a.key).join(', ') || '없음'})`
        );
      }
      if (entry.attachments && entry.attachments.length && attachments.length < entry.attachments.length) {
        warnings.push(`"${matchedName}" 별표 일부 미확인 (요청 ${entry.attachments.join(', ')})`);
      }

      laws.push({
        name: matchedName || entry.name,
        target,
        note: entry.note || '',
        mst,
        ...meta,
        link: `${SITE}/DRF/lawService.do?OC=test&target=${target}&MST=${mst}&type=HTML`,
        articles,
        attachments,
      });
      console.log(`  ✓ ${matchedName || entry.name} — 조문 ${articles.length}건, 별표 ${attachments.length}건`);
      await sleep(400);
    } catch (err) {
      const msg = err && err.message ? err.message.split('\n')[0] : String(err);
      warnings.push(`수집 실패: "${entry.name}" — ${msg}`);
      console.warn(`  ✗ ${entry.name}: ${msg}`);
      laws.push({ name: entry.name, target, note: entry.note || '', error: msg, articles: [], attachments: [] });
    }
  }

  // 이전 저장본 로드 (실패한 법령은 이전 좋은 데이터로 대체)
  let prev = null;
  try {
    prev = JSON.parse(await readFile(OUT_PATHS[0], 'utf8'));
  } catch {
    /* 최초 실행 */
  }
  const prevGood = new Map(
    (prev?.laws ?? [])
      .filter((l) => !l.error && Array.isArray(l.articles) && l.articles.length)
      .map((l) => [l.name, l])
  );

  const merged = laws.map((l) => {
    if (l.error && prevGood.has(l.name)) {
      warnings.push(`이번 수집 실패 → 이전 저장본 유지: "${l.name}"`);
      console.warn(`  ↺ ${l.name}: 이전 데이터 유지`);
      return { ...prevGood.get(l.name), note: l.note || prevGood.get(l.name).note, staleFromPrevious: true };
    }
    return l;
  });

  const freshOk = laws.filter((l) => !l.error).length;
  const usableOk = merged.filter((l) => !l.error).length;

  // 새로 받은 것도 없고 이전 저장본도 없으면 실패로 종료(워크플로가 빨갛게 뜨도록).
  if (usableOk === 0) {
    console.error('\n수집·이전본 모두 사용할 수 없습니다. 파일을 건드리지 않고 실패 처리합니다.');
    for (const w of warnings) console.error('  - ' + w);
    process.exit(1);
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    source: '국가법령정보센터 Open API (law.go.kr / DRF)',
    ocKey: usingTestKey ? 'test(공용키)' : '전용키',
    disclaimer:
      '이 파일은 GitHub Actions가 위 출처에서 미리 내려받아 저장한 정적 데이터입니다. ' +
      '웹페이지는 같은 도메인에서 이 파일만 읽으며 실행 중 외부 API를 호출하지 않습니다. ' +
      '법령은 개정될 수 있으므로 인용 전 law.go.kr 원문을 재확인하십시오.',
    warnings,
    laws: merged,
  };

  // laws 내용이 이전과 같으면(= fetchedAt만 변경) 무의미한 커밋을 피하려고 저장을 건너뛴다.
  if (prev && JSON.stringify(prev.laws ?? []) === JSON.stringify(merged)) {
    console.log(`\n내용 변화 없음 — 파일을 갱신하지 않습니다. (신규수집 ${freshOk}/${laws.length})`);
    if (warnings.length) for (const w of warnings) console.log('  - ' + w);
    return;
  }

  const json = JSON.stringify(out, null, 2) + '\n';
  for (const p of OUT_PATHS) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, json, 'utf8');
    console.log(`저장: ${p}`);
  }

  if (warnings.length) {
    console.log('\n경고:');
    for (const w of warnings) console.log('  - ' + w);
  }
  console.log(`\n완료: 신규수집 ${freshOk}/${laws.length}, 사용가능 ${usableOk}/${laws.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
