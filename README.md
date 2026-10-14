# profile-views-proxy

`komarev.com` 프로필 조회수 배지를 GitHub 프로필 README 에서 깨지지 않게 하는 얇은 프록시.

## 왜 필요한가

`komarev.com/ghpvc` 원본은 직접 부르면 항상 200 인데, GitHub camo 프록시를 거치면
`404 Cannot proxy the given URL` / `503 Error Fetching Resource` 가 섞여
**3번 중 2번꼴로 배지가 깨진다** (2026-10-14 실측: 12회 중 200 은 4회).
제작자도 camo 쪽 문제라고만 한다 (antonkomarev/github-profile-views-counter#121).

원본이 `max-age=0, no-store` 라 camo 가 성공본을 캐시할 수 없어서,
**프로필 방문마다 이 복불복을 다시 겪는다.**

## 어떻게 고치는가

camo 는 이 Vercel 함수만 부르고, 함수가 대신 komarev 를 부른다.
camo → Vercel 은 안정적이고(15/15), Vercel → komarev 도 안정적이다(20/20).

- **camo 의 User-Agent 를 그대로 넘긴다** — komarev 는 UA 가 `github-camo` 로
  시작할 때만 조회수를 올린다. camo 가 아닌 요청(직접 열기·봇)은 원래도
  집계되지 않으므로 우리 UA 로 바꿔 넘긴다.
- **캐시 금지** — 카운터라 캐시하면 방문이 집계되지 않는다. 성공·폴백 모두
  원본과 같은 `max-age=0, no-cache, no-store, must-revalidate` 를 보낸다.
- **camo 보다 짧은 원본 타임아웃** — 원본에 3초만 준다. 실패하면 숫자 자리에
  `–` 를 넣은 폴백 배지를 **200 으로** 반환한다. *깨진 이미지는 나오지 않는다.*

## 사용법

```
https://profile-views-proxy.vercel.app/api/views?username=knd0331&label=Profile%20views&color=10b981&style=flat
```

통과 허용 파라미터: `label`, `color`, `style`, `abbreviated` (각 32자 이하).
`base`(시작값)는 남의 카운터를 부풀리는 데 쓰일 수 있어 막는다.
`username` 은 GitHub 아이디 형식(`[A-Za-z0-9-]{1,39}`)만 허용하고, 아니면 기본값으로 떨어진다.

## 운영 메모

- Vercel 프로젝트: `innovation20/profile-views-proxy`
- **환경변수 없음** — 공개 엔드포인트만 호출하므로 토큰 만료로 죽을 일이 없다.
- 서버리스 함수 1개.
- Deployment Protection(Standard)은 켜 둔 채다. 배포별 URL 은 302 로 막히지만
  **프로덕션 별칭 `profile-views-proxy.vercel.app` 은 공개**라 README 에서 정상 동작한다.

## 테스트

```
npm test
```
