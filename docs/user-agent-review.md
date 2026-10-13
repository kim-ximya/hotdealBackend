# User-Agent 지정 검토

검토일: 2026-10-13

후속 구현: UI의 **브라우저** 탭에서 User-Agent를 저장하는 기능을 추가했습니다. 다음 서버 시작부터 적용하며, 빈 값은 Chrome 기본값을 사용합니다. 실제 사용법과 설정 우선순위는 [README](../README.md)를 참고하세요. 아래 내용은 구현 전 검토 기록입니다.

## 결론

현재 Selenium 수집기에 사용자 지정 User-Agent를 적용할 수 있습니다. 현재도 Chrome이 기본 User-Agent를 자동으로 전송하므로, 이 변경은 비어 있는 헤더를 채우는 것이 아니라 기본값을 바꾸는 기능입니다.

이번 검토에서는 로컬 HTTP 서버에 접속해 적용 여부를 검증했습니다. 아카라이브에서 User-Agent 변경 후 수집이 성공하는지는 테스트하지 않았습니다. 운영 수집기, UI, 설정과 기존 데이터는 변경하지 않았습니다.

## 적용 위치

`src/selenium-collector.js`의 `#getDriver()`에서 Chrome 옵션을 구성한 뒤, `Builder().build()`를 호출하기 전에 실행 인자를 추가합니다.

```js
const options = new chrome.Options();
options.addArguments(
  `--user-data-dir=${resolve(this.#directory, 'profile')}`,
  '--window-size=1200,900',
);
if (userAgent) options.addArguments(`--user-agent=${userAgent}`);

this.#driver = await new Builder()
  .forBrowser('chrome')
  .setChromeOptions(options)
  .build();
```

위 `userAgent`는 앞으로 추가할 설정값입니다. Chromium은 `--user-agent` 실행 인자를 지원하고 ChromeDriver는 Chrome 실행 인자를 전달할 수 있습니다. 서버의 Node.js HTTP 요청 헤더를 바꾸는 대신 실제 페이지에 접속하는 Chrome에 적용해야 합니다.

참고: [Chromium User-Agent 실행 옵션](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/embedder_support/switches.cc), [ChromeDriver ChromeOptions 문서](https://developer.chrome.com/docs/chromedriver/capabilities).

## 로컬 검증 결과

기존 운영 프로필과 분리된 새 프로필, Chrome 154.0.8037.99의 헤드리스 모드에서 테스트용 값 `HotdealCollectorReview/1.0`을 지정했습니다. 외부 사이트에는 접속하지 않았습니다.

| 확인 항목 | 결과 |
| --- | --- |
| 요청의 `User-Agent` 헤더 | 지정한 값과 일치 |
| 페이지의 `navigator.userAgent` | 지정한 값과 일치 |
| `Sec-CH-UA` 헤더 | Chromium / Google Chrome 154 정보 유지 |
| `navigator.userAgentData` | Chrome 브랜드·버전과 Windows 플랫폼 정보 유지 |

User-Agent 문자열과 Client Hints는 별도의 정보입니다. 문자열을 변경해도 브라우저의 모든 특성이 함께 바뀌는 것은 아닙니다. 테스트 브라우저와 로컬 서버는 종료했고 임시 브라우저 프로필은 정리했습니다. 결과는 Git에서 제외되는 `.local/useragent-review/result.json`에 남겼습니다. 임시 검증 스크립트는 헤드리스 방식을 운영 코드로 통합하면서 정리했습니다.

## 설정 설계 제안

- 선택 설정 `SELENIUM_USER_AGENT`를 추가합니다. 미설정·빈 값은 Chrome 기본값을 사용합니다. 현재 코드에는 이 설정이 아직 연결되어 있지 않습니다.
- `readServerConfig` → `createServerRuntime` → `SeleniumCollector` 생성자 순으로 값을 전달합니다.
- 설정값은 한 줄 문자열로 검증하고 개행·제어 문자를 거부합니다.
- UI에 제공한다면 기본값 사용/사용자 지정 선택과 입력란을 두고, 변경은 다음 서버 시작부터 적용합니다.
- 실제 설치된 브라우저·OS와 맞는 값을 사용하고, 무작위로 여러 브라우저의 문자열을 교체하는 동작은 넣지 않습니다. 기본값을 사용하는 것이 유지보수에 가장 단순합니다.

실행 중 변경이 꼭 필요하면 설치된 Selenium의 `sendDevToolsCommand()`를 통해 CDP `Emulation.setUserAgentOverride`를 사용할 수도 있습니다. 이 명령은 Client Hints용 메타데이터를 별도로 취급합니다. 현재 서버는 Chrome을 유지하므로 시작 시 실행 옵션으로 고정하는 방식이 더 단순합니다.

참고: [Chrome DevTools Protocol 정의](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl).

## 앞선 HTTP 403과의 관계

User-Agent 변경 기능 자체는 검증됐지만, 앞선 403의 원인이 User-Agent라는 증거는 없습니다. Cloudflare는 JavaScript 탐지·휴리스틱 등 여러 엔진을 사용한다고 설명하므로, 문자열 하나를 바꾸면 보안 확인을 통과한다고 결론 내릴 수 없습니다.

참고: [Cloudflare 봇 탐지 엔진 문서](https://developers.cloudflare.com/bots/concepts/bot-detection-engines/).

헤드리스 수집 가능성을 추가 검증하려면 기본 UA와 지정 UA를 다른 새 프로필에서 같은 조건으로 비교하고, HTTP 상태뿐 아니라 실제 게시글 파싱 성공 여부를 기록해야 합니다. 보안 확인 응답은 성공 데이터로 저장하지 않고 마지막 정상 JSON을 유지하는 기존 동작을 유지합니다.
