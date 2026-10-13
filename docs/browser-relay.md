# 핫딜 브라우저 중계 백엔드

사용자가 열어 둔 아카라이브 핫딜 탭의 **기존 WebSocket**에서 정확히 `na`인 메시지를 감지합니다. 브라우저에서 HTTP로 목록 HTML을 가져와 로컬 Node.js 백엔드로 전달하고, 백엔드는 이를 파싱해 게시글 목록 JSON API로 제공합니다. 정기적으로 오는 `c|숫자` 메시지는 새 글 알림으로 취급하지 않습니다.

현재 구현 범위는 목록 첫 페이지 수집, 파싱, 메모리 캐시, 목록 및 상태 조회입니다. 개별 게시글 본문·판매 링크·가격의 별도 추출과 영구 저장은 포함하지 않습니다. `na`는 갱신 신호이므로 메시지 수와 실제 새 게시글 수가 같다는 보장은 없습니다.

```text
아카라이브 핫딜 탭 ← 사이트의 기존 WebSocket
        ↓ 유저스크립트가 na 감지 (알림은 /api/relay로 전달)
브라우저에서 GET https://arca.live/b/hotdeal
        ↓ 받은 HTML을 POST /api/html로 전달
Node.js 백엔드에서 HTML 파싱 및 최신 목록 보관
        ↓
GET http://127.0.0.1:38471/api/articles → 게시글 목록 JSON
```

## 실행 및 설치

Node.js 22.4 이상이 필요합니다. HTML 파싱에는 Cheerio를 사용합니다.

1. 프로젝트 폴더에서 백엔드를 실행합니다.

   ```powershell
   npm install
   node main.js
   ```

   pnpm을 사용하면 `npm install` 대신 `pnpm install`로 잠금 파일의 버전을 설치할 수 있습니다.

2. 평소 아카라이브에 접속하는 브라우저에 [Tampermonkey](https://www.tampermonkey.net/)를 설치합니다. 브라우저에서 확장 프로그램의 사용자 스크립트 실행 권한을 요구하면 활성화합니다.
3. 같은 컴퓨터의 브라우저에서 [설치 안내](http://127.0.0.1:38471)를 열고 **유저스크립트 설치**를 누릅니다. Tampermonkey 설치 화면이 뜨면 설치합니다. 코드만 표시되면 해당 코드 전체를 복사해 Tampermonkey의 **새 스크립트 만들기** 편집기에 붙여 넣고 저장합니다.
4. [핫딜 채널](https://arca.live/b/hotdeal)을 **새로고침**한 뒤 탭을 계속 열어 둡니다. 사이트에서 보안 확인을 요구하면 사용자가 브라우저에서 완료합니다.
5. [연결 상태](http://127.0.0.1:38471/api/status)와 백엔드 터미널을 확인합니다. `browserOnline: true`는 브라우저 스크립트가 연결됐다는 뜻이고, `socketReceiving: true`는 구독한 WebSocket에서 메시지를 받았다는 뜻입니다. 사이트 WebSocket 연결 여부는 상태의 `socketState`로도 확인할 수 있습니다.
6. [게시글 목록](http://127.0.0.1:38471/api/articles)을 확인합니다. 최초 페이지 로드 후 한 번 수집하므로 `na`가 오기 전에도 목록을 확인할 수 있습니다. 성공 여부는 `collection.updatedAt`과 `collection.lastError`로 확인합니다.

**이전 버전을 사용했다면 백엔드를 재시작하고, 설치 주소에서 유저스크립트를 0.3.0으로 다시 설치한 뒤 핫딜 탭을 새로고침하세요.**

**저장소의 `browser/hotdeal-relay.user.js`는 설치용 템플릿입니다.** 반드시 실행 중인 백엔드의 `/hotdeal-relay.user.js`에서 제공하는 코드를 설치하세요. 해당 응답에는 실행 주소와 이 백엔드의 인증값이 채워져 있습니다. 설치된 스크립트는 중복되지 않도록 하나만 활성화하고, 수집용 핫딜 탭도 하나만 열어 두세요.

정상 동작 시 다음 형식으로 출력됩니다. 아래는 출력 예시이며 실제 사이트 수신 기록은 아닙니다.

```text
[시간] 브라우저 스크립트 연결 완료 (상태: waiting)
[시간] 브라우저의 핫딜 WebSocket 구독 감지 (상태: subscribed)
[시간] 새 글 알림(na) 수신: {"channel":"/b/hotdeal","receivedAt":"...","browserReceivedAt":"..."}
[시간] 핫딜 목록 갱신 완료: 35개 (계기: na)
```

## 동작과 상태 API

유저스크립트는 페이지 시작 시 `WebSocket` 생성자를 감싸 `wss://arca.live/arcalive` 연결과 `c|/b/hotdeal` 구독을 관찰합니다. 사이트가 보내는 `hello` 등의 메시지는 그대로 통과시키며 새 WebSocket을 추가로 만들지 않습니다. 사이트의 원래 코드가 생성한 연결에서만 이벤트를 받으므로, 설치 후 페이지 새로고침이 필요합니다. 재접속으로 새 소켓이 만들어져도 다시 관찰합니다.

HTTP 요청도 로그인·접속 상태를 가진 **같은 브라우저**에서 `fetch`로 수행합니다. 브라우저의 쿠키는 사이트 요청에만 사용되며, 백엔드에는 HTML과 수집 메타데이터만 전달됩니다. 백엔드용 Bearer 인증값을 아카라이브에 보내지 않습니다. 검색·정렬·페이지 이동과 무관하게 수집 URL은 항상 `https://arca.live/b/hotdeal`입니다.

최초 로드 후 한 번, 이후에는 `na`를 받았을 때만 요청합니다. 250ms의 짧은 대기 시간으로 연속 알림을 묶고 HTTP 요청 시작 간격을 최소 3초로 제한합니다. 요청 중 들어온 알림은 완료 후 한 번 더 갱신하도록 반영합니다. 주기적인 HTML 폴링은 없습니다. 오류 화면이나 파싱 실패는 기존 목록을 덮어쓰지 않습니다.

`GET /api/articles` 응답 예시 (예시 데이터):

```json
{
  "channel": "/b/hotdeal",
  "sourceUrl": "https://arca.live/b/hotdeal",
  "updatedAt": "2026-10-12T09:00:01.000Z",
  "fetchedAt": "2026-10-12T09:00:00.000Z",
  "total": 1,
  "articles": [
    {
      "id": "123456789",
      "url": "https://arca.live/b/hotdeal/123456789",
      "title": "[쇼핑몰] SSD 특가",
      "category": "전자제품",
      "author": "작성자",
      "createdAt": "2026-10-12T08:59:00Z",
      "views": 100,
      "recommendations": 3,
      "commentCount": 5,
      "isNotice": false
    }
  ]
}
```

- 수집 전에는 `articles: []`, `updatedAt: null`, `fetchedAt: null`입니다.
- `updatedAt`은 백엔드 반영 시각, `fetchedAt`은 브라우저의 HTML 수신 완료 시각입니다.
- `id`는 문자열입니다. 링크는 핫딜 채널의 숫자 ID만 허용하고 쿼리·해시를 제거합니다. 같은 ID는 목록에서 한 번만 반환합니다.
- 일반 핫딜의 hybrid 행에서는 분류 링크와 게시글 링크가 함께 나타납니다. 분류 링크를 제외한 뒤 숫자 게시글 ID가 있는 링크를 선택하며, 하단 가격·작성자 링크나 이미지 링크를 제목으로 사용하지 않습니다. 일반 글의 링크를 찾았는데 제목을 추출하지 못하면 수집 오류로 처리해 공지만 있는 불완전한 결과로 캐시를 덮어쓰지 않습니다.
- 작성자 이름의 앞뒤 공백을 제거한 후 `*`로 시작하는 운영진 글은 공지로 간주해 목록에서 제외합니다. 작성자 정보가 없거나 이름 중간에만 `*`가 있는 글은 유지합니다. `total`과 상태의 `articleCount`는 필터 적용 후 개수입니다. 그 밖의 공지는 `isNotice`로 구분합니다.
- 현재 HTML에 없는 선택 필드는 `null`입니다. `createdAt`은 HTML의 시각 문자열을 유지하며, 시간대가 없는 값을 임의로 변환하지 않습니다.
- HTML과 스크립트를 프론트엔드에 그대로 반환하지 않습니다. 제목 등은 텍스트로 출력하세요. API를 호출해도 아카라이브 HTTP 요청을 추가로 발생시키지 않습니다.
- 목록은 현재 첫 페이지의 스냅샷입니다. 페이지에서 밀려난 글은 다음 목록에서 빠지며, 수집 중단 동안의 모든 글을 복구하는 기능은 없습니다.

`GET /api/status` 응답 예시:

```json
{
  "mode": "browser-relay",
  "channel": "/b/hotdeal",
  "browserOnline": true,
  "socketReceiving": true,
  "newArticleCount": 1,
  "lastNewArticleAt": "2026-10-12T09:00:00.000Z",
  "collection": {
    "articleCount": 35,
    "updatedAt": "2026-10-12T09:00:01.000Z",
    "fetchedAt": "2026-10-12T09:00:00.900Z",
    "lastError": null
  },
  "clients": [
    {
      "clientId": "브라우저-탭-식별자",
      "socketState": "receiving",
      "lastSeenAt": "2026-10-12T09:00:00.000Z",
      "online": true
    }
  ]
}
```

- `socketState`: `waiting`(구독 대기), `subscribed`(구독 감지), `receiving`(메시지 수신), `closed`(연결 종료), `error`(소켓 오류).
- 브라우저는 상태를 약 15초마다 전달합니다. 45초간 전달되지 않으면 `browserOnline`이 `false`가 됩니다. 탭 절전·PC 절전·브라우저 타이머 제한으로 상태 전달이 늦어질 수 있습니다.
- `socketReceiving`은 최근에 전달된 소켓 상태입니다. 이 값만으로 앞으로도 메시지가 도착한다고 보장하지 않습니다.
- `newArticleCount`는 이번 백엔드 실행 중 받은 `na` 알림 수입니다. 카운터와 상태, 중복 방지 기록은 메모리에만 유지됩니다.
- `collection.lastError`는 최근 수집 실패 시 `{ message, httpStatus, at }`이며, 수집 성공 시 `null`로 초기화됩니다. 연결 상태와 수집 상태는 별개입니다. `subscribed`만으로 WebSocket 메시지나 HTML을 성공적으로 받았다는 의미는 아닙니다.
- `src/browser-relay.js`의 `BrowserRelay`는 `newArticle`, `articlesUpdated`, `collectionError` 이벤트를 발생시킵니다.

## 재시작과 주의사항

- **백엔드 중단:** 브라우저는 전송 실패 시 5초 뒤 재시도하며 탭 메모리에 최대 100개 이벤트를 보관합니다. 가득 차면 오래된 대기 이벤트를 버리고 콘솔에 경고합니다. 탭 새로고침·종료 시 대기열은 사라집니다.
- **목록 재전송:** 대기 중인 HTML 스냅샷은 최신 것으로 합칩니다. 백엔드 재시작 시 목록 캐시도 초기화되므로, 다음 `na`를 기다리거나 핫딜 탭을 새로고침하면 다시 수집합니다. 백엔드는 늦게 도착한 과거 스냅샷으로 최신 목록을 덮어쓰지 않습니다.
- **HTTP 실패:** 네트워크 오류나 HTTP 5xx는 다음 `na` 또는 탭 새로고침 때 다시 수집합니다. 보안 확인 응답과 HTTP 401·403·429는 사이트 요청을 중지하므로, 브라우저에서 정상 접속을 확인한 뒤 탭을 새로고침하세요. 요청 제한 시간은 15초, HTML 크기 제한은 UTF-8 기준 1 MiB입니다.
- **전송 중복:** 동일 이벤트 재시도는 백엔드가 최근 2,048개 이벤트 ID로 걸러냅니다. 서로 다른 탭이 같은 `na`를 받는 경우는 별개 이벤트입니다. 백엔드 재시작 시 중복 기록도 초기화되므로 영구적인 무손실 수집은 아닙니다.
- **소켓 종료:** 사이트의 원래 재접속 동작을 따릅니다. 상태가 계속 `closed`/`error`이면 핫딜 탭을 새로고침해 확인하세요.
- **인증:** 최초 실행 시 `.local/relay-token`을 생성하고 이후 재사용합니다. 이 파일을 삭제하거나 인증값이 바뀌면 설치 주소에서 스크립트를 다시 설치하고 핫딜 탭을 새로고침하세요. `.local/`은 Git에서 제외됩니다. 생성된 설치 스크립트에도 인증값이 있으므로 공유하지 마세요.
- **접속 범위:** 백엔드는 `127.0.0.1`에만 바인딩합니다. 브라우저와 백엔드는 같은 컴퓨터에서 실행해야 합니다. 상태 API는 웹·Windows 앱 등에서 사용할 수 있지만, 일반 웹페이지에서 직접 요청하려면 프론트엔드 출처에 맞는 CORS/프록시 설정을 별도로 추가해야 합니다.
- **브라우저 권한:** 중계 요청은 Tampermonkey의 `GM_xmlhttpRequest`를 사용합니다. 확장 프로그램이나 브라우저가 로컬 연결 허용을 요구할 수 있습니다. 인증 실패 시 자동 전송을 중지하고 브라우저 콘솔에 재설치 안내를 표시합니다.
- **보안 확인:** 아카라이브 접속은 사용자 브라우저가 처리합니다. 보안 확인을 자동으로 통과시키는 기능은 없습니다.

포트를 변경하려면 다음처럼 실행한 뒤, **새 포트의 설치 주소**에서 스크립트를 다시 설치하고 핫딜 탭을 새로고침합니다.

```powershell
$env:PORT = '38472'
node main.js
```

## 검증

```powershell
node --test
```

테스트는 모의 WebSocket·HTTP 응답과 로컬 백엔드로 구독 감지, `na` 필터링, HTML 수집 예약·요청 병합, 파싱, 목록 API, 실패 시 캐시 보존, 재시도, 인증과 중복 제거를 검증합니다. `hotdeal-list.html`은 목록 선택자를 바탕으로 만든 예시이고, `hotdeal-hybrid.html`은 사용자가 제공한 실제 일반 핫딜 행의 구조를 반영한 회귀 테스트 자료입니다. 분류 링크가 게시글 링크보다 먼저 등장해 일반 글을 놓치는 경우와 공지만 파싱되는 경우를 검증합니다. 실제 아카라이브 HTTP 응답과 사용자의 Tampermonkey 환경에서는 설치 후 확인해야 하며, HTML 구조가 다르면 파서 선택자를 조정해야 합니다.

참고: [ArcaRefresher의 HTTP 목록 갱신](https://github.com/lekakid/ArcaRefresher/blob/45c94f8a0dd120f75ec9db2014d58d7f0497e48d/src/feature/Board/AutoRefresher/article.jsx)과 [목록 선택자](https://github.com/lekakid/ArcaRefresher/blob/45c94f8a0dd120f75ec9db2014d58d7f0497e48d/src/core/selector.jsx)를 검토했고, 이 프로젝트의 코드는 별도로 작성했습니다. [Tampermonkey 문서](https://www.tampermonkey.net/documentation.php), [Cheerio HTML 로딩 문서](https://cheerio.js.org/docs/basics/loading/)도 참고하세요.
