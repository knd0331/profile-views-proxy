const test = require('node:test')
const assert = require('node:assert/strict')

const handler = require('../api/views.js')

/** 핸들러가 쓰는 최소한의 res 인터페이스를 흉내낸다 */
function createMockRes() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    send(payload) {
      this.body = payload
      return this
    },
  }
}

/** global.fetch 를 교체하고, 호출된 URL·옵션을 기록해 돌려준다 */
function stubFetch(implementation) {
  const calls = []
  const options = []
  const original = global.fetch

  global.fetch = async (url, fetchOptions) => {
    calls.push(url)
    options.push(fetchOptions)
    return implementation(url, fetchOptions)
  }

  return {
    calls,
    options,
    restore() {
      global.fetch = original
    },
  }
}

const VALID_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="110.2" height="20"><text>567</text></svg>'

function okResponse(body = VALID_SVG) {
  return { ok: true, status: 200, text: async () => body }
}

test('원본이 정상 SVG를 주면 그대로 전달한다', async () => {
  // Arrange
  const fetchStub = stubFetch(() => okResponse())
  const res = createMockRes()

  // Act
  await handler({ query: {} }, res)
  fetchStub.restore()

  // Assert
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, VALID_SVG)
  assert.equal(res.headers['x-proxy-source'], 'komarev')
  assert.match(res.headers['content-type'], /^image\/svg\+xml/)
})

test('조회수 카운터이므로 성공 응답도 어디서도 캐시하지 않는다', async () => {
  const fetchStub = stubFetch(() => okResponse())
  const res = createMockRes()

  await handler({ query: {} }, res)
  fetchStub.restore()

  // 캐시되면 camo 가 원본까지 오지 않아 방문이 집계되지 않는다
  assert.match(res.headers['cache-control'], /no-store/)
  assert.match(res.headers['cache-control'], /max-age=0/)
})

test('camo 가 보낸 요청이면 User-Agent 를 그대로 넘겨 조회수가 집계되게 한다', async () => {
  // komarev 는 User-Agent 가 github-camo 로 시작할 때만 조회수를 올린다
  const camoUserAgent = 'github-camo (876de43e)'
  const fetchStub = stubFetch(() => okResponse())

  await handler({ query: {}, headers: { 'user-agent': camoUserAgent } }, createMockRes())
  fetchStub.restore()

  assert.equal(fetchStub.options[0].headers['user-agent'], camoUserAgent)
})

test('camo 가 아닌 요청(직접 열기·봇)은 camo User-Agent 를 넘기지 않아 집계되지 않는다', async () => {
  const fetchStub = stubFetch(() => okResponse())

  await handler({ query: {}, headers: { 'user-agent': 'curl/8.7.1' } }, createMockRes())
  await handler({ query: {} }, createMockRes())
  fetchStub.restore()

  for (const options of fetchStub.options) {
    assert.doesNotMatch(options.headers['user-agent'], /^github-camo/)
  }
})

test('원본이 타임아웃되면 폴백 배지를 200으로 반환한다', async () => {
  const abortError = new Error('aborted')
  abortError.name = 'AbortError'
  const fetchStub = stubFetch(() => Promise.reject(abortError))
  const res = createMockRes()

  await handler({ query: {} }, res)
  fetchStub.restore()

  // camo 에 에러를 노출하면 배지가 깨지므로 반드시 200 이어야 한다
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['x-proxy-source'], 'fallback')
  assert.match(res.body, /<svg/)
  assert.match(res.body, /Profile views/)
})

test('원본이 응답하지 않으면 3초에 끊고 폴백으로 떨어진다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fetchStub = stubFetch(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const abortError = new Error('aborted')
          abortError.name = 'AbortError'
          reject(abortError)
        })
      }),
  )
  const res = createMockRes()

  const pending = handler({ query: {} }, res)
  t.mock.timers.tick(2999)
  await Promise.resolve()
  assert.equal(res.statusCode, null)

  t.mock.timers.tick(1)
  await pending
  fetchStub.restore()

  assert.equal(res.headers['x-proxy-source'], 'fallback')
})

test('폴백도 캐시하지 않아 다음 방문에서 바로 원본을 다시 시도한다', async () => {
  const fetchStub = stubFetch(() => Promise.reject(new Error('boom')))
  const res = createMockRes()

  await handler({ query: {} }, res)
  fetchStub.restore()

  assert.match(res.headers['cache-control'], /no-store/)
})

test('원본이 4xx/5xx면 폴백으로 떨어진다', async () => {
  const fetchStub = stubFetch(() => ({ ok: false, status: 503, text: async () => 'unavailable' }))
  const res = createMockRes()

  await handler({ query: {} }, res)
  fetchStub.restore()

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['x-proxy-source'], 'fallback')
})

test('원본이 200이어도 SVG가 아니면 폴백으로 떨어진다', async () => {
  const fetchStub = stubFetch(() => okResponse('<html>error page</html>'))
  const res = createMockRes()

  await handler({ query: {} }, res)
  fetchStub.restore()

  assert.equal(res.headers['x-proxy-source'], 'fallback')
})

test('username 이 없으면 기본 계정을 사용한다', async () => {
  const fetchStub = stubFetch(() => okResponse())
  await handler({ query: {} }, createMockRes())
  fetchStub.restore()

  assert.equal(fetchStub.calls[0], 'https://komarev.com/ghpvc/?username=knd0331')
})

test('허용된 파라미터는 원본으로 전달한다', async () => {
  const fetchStub = stubFetch(() => okResponse())
  await handler(
    { query: { username: 'octocat', label: 'Profile views', color: '10b981', style: 'flat' } },
    createMockRes(),
  )
  fetchStub.restore()

  assert.equal(
    fetchStub.calls[0],
    'https://komarev.com/ghpvc/?username=octocat&label=Profile+views&color=10b981&style=flat',
  )
})

test('형식에 맞지 않는 username 은 기본 계정으로 떨어진다', async () => {
  const fetchStub = stubFetch(() => okResponse())
  // 다른 사람 카운터를 올리거나 쿼리를 오염시키려는 시도
  await handler({ query: { username: 'knd0331&base=999999' } }, createMockRes())
  fetchStub.restore()

  assert.equal(fetchStub.calls[0], 'https://komarev.com/ghpvc/?username=knd0331')
})

test('화이트리스트에 없거나 너무 긴 파라미터는 원본 URL 에 넣지 않는다', async () => {
  const fetchStub = stubFetch(() => okResponse())
  await handler({ query: { style: 'flat', base: '999999', label: 'x'.repeat(33) } }, createMockRes())
  fetchStub.restore()

  assert.equal(fetchStub.calls[0], 'https://komarev.com/ghpvc/?username=knd0331&style=flat')
})

test('폴백 배지는 label 을 이스케이프해 SVG 에 스크립트를 넣을 수 없다', async () => {
  const fetchStub = stubFetch(() => Promise.reject(new Error('boom')))
  const res = createMockRes()

  await handler({ query: { label: '<script>x</script>' } }, res)
  fetchStub.restore()

  assert.doesNotMatch(res.body, /<script>/)
  assert.match(res.body, /&lt;script&gt;/)
})

test('폴백 배지는 hex 색상만 반영하고 나머지는 기본색을 쓴다', async () => {
  const fetchStub = stubFetch(() => Promise.reject(new Error('boom')))
  const hexRes = createMockRes()
  const badRes = createMockRes()

  await handler({ query: { color: '10b981' } }, hexRes)
  await handler({ query: { color: 'red"/><script>' } }, badRes)
  fetchStub.restore()

  assert.match(hexRes.body, /fill="#10b981"/)
  assert.doesNotMatch(badRes.body, /<script>/)
})
