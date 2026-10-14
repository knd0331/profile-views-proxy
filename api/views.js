// komarev.com 프로필 조회수 배지 프록시
//
// 존재 이유: komarev 원본(모스크바 단일 서버)은 직접 호출하면 100% 200 인데,
// GitHub camo 프록시를 거치면 `404 Cannot proxy the given URL` /
// `503 Error Fetching Resource` 가 섞여 3번 중 2번꼴로 배지가 깨진다 (2026-10-14 실측).
// 원본이 `max-age=0, no-store` 라 camo 가 성공본을 캐시할 수도 없어서
// 프로필 방문마다 이 복불복을 다시 겪는다. 제작자도 camo 쪽 문제라고만 한다
// (antonkomarev/github-profile-views-counter#121).
//
// 해결: camo 는 이 Vercel 함수만 부르고, 함수가 대신 komarev 를 부른다.
//   - komarev 는 User-Agent 가 `github-camo` 로 시작할 때만 조회수를 올린다
//     (public/index.php `$isGitHubUserAgent`). 그래서 camo 가 보낸 UA 를 그대로 넘긴다.
//     camo 가 아닌 요청(직접 열기·봇)은 원래도 집계되지 않으므로 우리 UA 로 바꿔 넘긴다
//   - 카운터라 캐시하면 방문이 집계되지 않으므로 성공·폴백 모두 캐시 금지
//   - 원본 타임아웃을 camo 한계(~4.2초)보다 짧게 잡아, 실패해도 폴백 배지를 200 으로 반환
// 결과적으로 camo 는 항상 200 을 받는다 — 깨진 이미지가 나올 수 없다.

const KOMAREV_ORIGIN = 'https://komarev.com/ghpvc/'

const CAMO_USER_AGENT_PREFIX = 'github-camo'
const PROXY_USER_AGENT = 'profile-views-proxy'

// camo 업스트림 타임아웃(~4.2초)보다 확실히 짧아야 한다.
// Vercel 함수 자체의 콜드스타트 여유를 빼고 3초로 잡는다.
const ORIGIN_TIMEOUT_MS = 3000

// 카운터는 매 방문이 원본까지 가야 집계된다 — 원본과 같은 지시자를 그대로 쓴다
const NO_CACHE = 'max-age=0, no-cache, no-store, must-revalidate'

const DEFAULT_USERNAME = 'knd0331'
const USERNAME_PATTERN = /^[A-Za-z0-9-]{1,39}$/

// 원본에 그대로 넘길 쿼리 파라미터 화이트리스트.
// `base`(시작값) 같은 파라미터로 남의 카운터를 조작하지 못하게 표시용만 허용한다.
const ALLOWED_PARAMS = ['label', 'color', 'style', 'abbreviated']
const MAX_PARAM_LENGTH = 32

const DEFAULT_LABEL = 'Profile views'
const DEFAULT_COLOR = '#007ec6' // komarev 기본색(blue)
const HEX_COLOR_PATTERN = /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

// 폴백 배지 치수 — shields flat 스타일(Verdana 11px)의 근사값
const BADGE_HEIGHT = 20
const CHAR_WIDTH = 6.5
const LABEL_PADDING = 10
const VALUE_WIDTH = 24

/** 쿼리 값 중 길이 제한을 통과한 문자열만 돌려준다 */
function pickParam(query, key) {
  const value = query[key]
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PARAM_LENGTH ? value : null
}

/** 요청 쿼리에서 검증된 username 과 통과 허용 파라미터만 뽑아 원본 URL 을 만든다 */
function buildOriginUrl(query) {
  const requested = typeof query.username === 'string' ? query.username : DEFAULT_USERNAME
  const username = USERNAME_PATTERN.test(requested) ? requested : DEFAULT_USERNAME

  const params = new URLSearchParams({ username })
  for (const key of ALLOWED_PARAMS) {
    const value = pickParam(query, key)
    if (value !== null) {
      params.set(key, value)
    }
  }

  return `${KOMAREV_ORIGIN}?${params.toString()}`
}

/** camo 가 보낸 UA 면 그대로, 아니면 집계되지 않는 우리 UA 를 돌려준다 */
function pickUserAgent(headers) {
  const incoming = headers?.['user-agent']
  return typeof incoming === 'string' && incoming.startsWith(CAMO_USER_AGENT_PREFIX) ? incoming : PROXY_USER_AGENT
}

/** SVG 텍스트 노드·속성에 넣을 문자열을 이스케이프한다 */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 원본이 실패할 때 내보낼 자리표시 배지 (숫자 자리에 '–') */
function buildFallbackSvg(query) {
  const label = escapeXml(pickParam(query, 'label') ?? DEFAULT_LABEL)
  const color = pickParam(query, 'color')
  const valueColor = color !== null && HEX_COLOR_PATTERN.test(color) ? `#${color}` : DEFAULT_COLOR

  const labelWidth = Math.round(label.length * CHAR_WIDTH) + LABEL_PADDING
  const totalWidth = labelWidth + VALUE_WIDTH

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${BADGE_HEIGHT}" role="img" aria-label="${label}: unavailable">
  <rect width="${labelWidth}" height="${BADGE_HEIGHT}" fill="#555"/>
  <rect x="${labelWidth}" width="${VALUE_WIDTH}" height="${BADGE_HEIGHT}" fill="${valueColor}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + VALUE_WIDTH / 2}" y="14">–</text>
  </g>
</svg>`
}

/** 타임아웃이 걸린 원본 호출. 성공하면 SVG 문자열, 실패하면 null */
async function fetchOriginSvg(url, userAgent) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ORIGIN_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'image/svg+xml', 'user-agent': userAgent },
    })

    if (!response.ok) {
      console.error(`komarev origin returned ${response.status} for ${url}`)
      return null
    }

    const body = await response.text()
    // 원본이 200 과 함께 에러 페이지를 줄 수도 있으므로 형태를 확인한다
    if (!body.includes('<svg')) {
      console.error(`komarev origin returned non-SVG body for ${url}`)
      return null
    }

    return body
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `timeout after ${ORIGIN_TIMEOUT_MS}ms` : error?.message
    console.error(`komarev origin fetch failed (${reason}) for ${url}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 캐시 금지 헤더를 붙여 SVG 를 내보낸다 — 어떤 실패든 camo 에는 항상 200 */
function sendSvg(res, svg, source) {
  res.setHeader('Cache-Control', NO_CACHE)
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
  res.setHeader('X-Proxy-Source', source)
  res.status(200).send(svg)
}

module.exports = async (req, res) => {
  const query = req.query || {}
  const svg = await fetchOriginSvg(buildOriginUrl(query), pickUserAgent(req.headers))

  if (svg) {
    sendSvg(res, svg, 'komarev')
    return
  }

  sendSvg(res, buildFallbackSvg(query), 'fallback')
}
