# Selenium 핫딜 수집 서버

Selenium이 실행한 Chrome에서 아카라이브 핫딜 목록을 **기본 3분(180초)마다** 수집합니다. 게시글을 ID로 병합해 JSON 파일에 저장하고, 웹페이지·Windows 앱 등에서 사용할 수 있는 조회 API를 제공합니다.

```text
전용 Chrome → 핫딜 목록 HTML → 게시글 파싱 → articles.json 저장 → 조회 API
                    ↑ 설정한 간격마다 실행
```

## 실행

Node.js 22.4 이상과 Chrome이 필요합니다. ChromeDriver는 공식 Selenium Manager가 준비합니다.

```powershell
npm install
node main.js
```

pnpm을 사용하면 `pnpm install` 후 `pnpm start`로 실행할 수 있습니다. 시작 시 즉시 한 번 수집하며, 이후 설정한 간격으로 수집합니다. 서버 실행 중 전용 Chrome 창을 계속 유지합니다. 보안 확인이 나타나면 해당 창에서 직접 완료하세요. 종료는 `Ctrl+C`이며, 수집 예약과 전용 브라우저를 함께 종료합니다.

같은 포트를 사용하는 서버가 이미 실행 중이면 먼저 종료하세요.

- [게시글 목록](http://127.0.0.1:38471/api/articles)
- [수집 상태](http://127.0.0.1:38471/api/status)
- [현재 수집 간격](http://127.0.0.1:38471/api/settings)

## 수집 간격 및 설정

설정하지 않으면 간격은 180초입니다. 실행 시 지정하려면 다음처럼 환경변수를 사용합니다.

```powershell
$env:CRAWL_INTERVAL_SECONDS = '300'
node main.js
```

서버 실행 중에는 API로 변경할 수 있습니다. 값은 **초 단위의 정수(1~86400)**입니다.

```powershell
Invoke-RestMethod -Method Put `
  -Uri 'http://127.0.0.1:38471/api/settings' `
  -ContentType 'application/json' `
  -Body '{"intervalSeconds":180}'
```

변경한 간격은 `settings.json`에 저장되어 재시작 후에도 유지됩니다. 우선순위는 **환경변수/`.env`의 명시적 값 → 저장된 설정 → 기본 180초**입니다. 환경변수로 간격을 고정하면 실행 중 API 변경은 적용되지만, 다음 재시작 시 환경변수가 다시 우선합니다.

루트의 `.env.example`을 `.env`로 복사해 설정할 수도 있습니다. 서버가 `.env`를 자동으로 읽으며, 이미 지정된 외부 환경변수를 우선합니다.

| 설정 | 기본값 | 용도 |
| --- | --- | --- |
| `CRAWL_INTERVAL_SECONDS` | 180 또는 저장된 설정 | 수집 간격(초) |
| `PORT` | 38471 | API 포트 |
| `DATA_DIR` | `.local/selenium-server` | 게시글·설정·브라우저 프로필·드라이버 저장 폴더 |
| `MAX_ARTICLES` | 10000 | 최신 ID부터 보관할 최대 게시글 수(1~100000) |
| `SELENIUM_WAIT_SECONDS` | 120 | 접속·보안 확인 후 목록을 기다리는 시간(초) |
| `SELENIUM_CHROME_BINARY` | 자동 탐색 | Chrome 실행 파일 경로 |
| `FRONTEND_ORIGINS` | 없음 | CORS를 허용할 정확한 HTTP(S) 출처 목록(쉼표 구분) |

한 번의 수집이 오래 걸리면 중간에 예정된 실행은 건너뜁니다. 작업을 겹쳐 실행하거나 놓친 횟수만큼 연속 요청하지 않습니다. 간격 변경은 예약을 다시 계산하며, 진행 중인 수집은 그대로 완료합니다.

## 저장 방식

기본 파일은 `.local/selenium-server/articles.json`입니다. 임시 파일에 작성·동기화한 후 교체하며, 파일 저장 성공 후에만 API의 조회 데이터를 갱신합니다. 수집이나 저장 실패 시 마지막 성공 데이터를 유지합니다. 서버 재시작 시 기존 JSON을 읽고 누적 수집을 이어갑니다. 파일이 손상되었으면 이를 덮어쓰지 않고 시작 오류를 출력합니다.

- 새로운 게시글 ID는 추가하고, 이미 있는 ID는 조회·댓글 수 등 현재 정보를 갱신합니다.
- `firstSeenAt`은 처음 수집한 시각, `lastSeenAt`은 마지막으로 수집한 시각입니다.
- 이전에 수집한 글이 첫 페이지에서 밀려나도 보관합니다. 보관 한도를 넘으면 가장 오래된 ID부터 제거합니다.
- 작성자 이름이 `*`로 시작하는 글은 제외합니다. 기타 공지 여부는 `isNotice`에 표시합니다.
- HTML의 분류 링크와 게시글 링크를 구분하며, 선택 정보가 없으면 `null`을 사용합니다.
- **현재 수집 범위는 첫 페이지입니다.** 수집 간격 사이에 첫 페이지 밖으로 밀려난 글, 수집 중단 동안의 모든 글을 복구하지는 않습니다. 과거 글 전체 수집이나 삭제·종료된 딜의 추적 기능은 포함하지 않습니다.

저장 파일 예시:

```json
{
  "schemaVersion": 1,
  "channel": "/b/hotdeal",
  "sourceUrl": "https://arca.live/b/hotdeal",
  "updatedAt": "2026-10-13T04:00:00.000Z",
  "latestCount": 26,
  "total": 100,
  "articles": [
    {
      "id": "185704738",
      "url": "https://arca.live/b/hotdeal/185704738",
      "title": "하우스 플리퍼 2",
      "category": "SW/게임",
      "author": "작성자",
      "createdAt": "2026-10-12T08:24:14.000Z",
      "views": 23,
      "recommendations": 0,
      "commentCount": null,
      "isNotice": false,
      "firstSeenAt": "2026-10-13T03:00:00.000Z",
      "lastSeenAt": "2026-10-13T04:00:00.000Z"
    }
  ]
}
```

위 JSON은 형식을 보여 주는 예시이며, `articles`는 한 건만 발췌했습니다.

## API

| 메서드·경로 | 내용 |
| --- | --- |
| `GET /api/articles?limit=100&offset=0` | 저장된 목록. 기본 100개, 최대 1000개, 최신 ID 순 |
| `GET /api/status` | 실행 상태, 다음 수집 시각, 성공 횟수, 최근 오류, 브라우저 상태 |
| `GET /api/settings` | 현재 `intervalSeconds` |
| `PUT /api/settings` | JSON `{"intervalSeconds":180}`으로 간격 변경·저장 |
| `POST /api/collect` | JSON `{}`로 즉시 수집. 진행 중이면 같은 작업에 합류 |

조회 API에는 저장 형식에 `limit`, `offset`, `returnedCount`가 추가됩니다. `total`은 전체 보관 수, `latestCount`는 마지막 수집 목록의 개수입니다. 조회 API 호출은 사이트에 추가 접속하지 않습니다.

즉시 수집 요청은 `202 Accepted`를 반환합니다. 완료 여부는 상태 API로 확인합니다.

```powershell
Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:38471/api/collect' `
  -ContentType 'application/json' `
  -Body '{}'
```

상태의 주요 항목은 `isCollecting`, `nextRunAt`, `lastSuccessAt`, `lastError`, `attempts`, `successes`, `consecutiveFailures`, `articleCount`입니다. `lastSuccessAt`은 재시작 시 저장 파일의 갱신 시각으로 복구하고, 실행 횟수는 이번 서버 실행 기준입니다. `browser.attentionRequired`가 `true`이면 전용 Chrome의 보안 확인 화면을 확인하세요. 재접속이나 파싱 실패는 `lastError`로 보고하고 다음 예약 시 다시 시도합니다.

서버는 `127.0.0.1`에 바인딩합니다. Windows 앱의 일반 HTTP 클라이언트에서는 바로 사용할 수 있습니다. 다른 포트에서 실행하는 웹 프론트엔드는 `.env`에 출처를 등록합니다.

```dotenv
FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

설정 변경 API도 해당 출처에서 사용할 수 있습니다. 등록되지 않은 출처와 다른 Host의 요청은 거부합니다. `file://` 페이지 대신 로컬 개발 서버를 사용하세요.

## 검증

```powershell
node --test
```

로컬 테스트는 HTML 파싱·필터링, 수집 예약, 작업 중복 방지, 간격 변경 저장, 게시글 병합·보관 한도, 파일 재로딩, 실패 시 기존 데이터 유지, API와 CORS를 검증합니다. 실제 사이트 수집 여부는 서버 실행 후 `/api/status`와 `/api/articles`에서 확인합니다. 브라우저 보안 확인을 자동으로 통과시키거나 자동화 탐지를 숨기는 설정은 없습니다.
