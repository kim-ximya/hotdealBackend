# Selenium 단일 접속 테스트

기존 백엔드 및 HTTP 테스트와 별개로, 화면이 보이는 Chrome에서 핫딜 목록에 한 번 접속합니다. Node.js 22.4 이상과 Chrome이 필요합니다.

프로젝트 루트에서 설치·실행합니다.

```powershell
npm --prefix scripts/selenium-probe install
node scripts/selenium-probe/probe.js
```

pnpm 사용 시 `pnpm --dir scripts/selenium-probe install`로 설치할 수 있습니다. 테스트 의존성 및 잠금 파일은 이 폴더에만 생성됩니다.

- ChromeDriver는 공식 Selenium Manager가 필요한 버전을 내려받습니다.
- 브라우저 프로필과 드라이버 캐시는 `.local/selenium-probe/` 안에 생성됩니다. 평소 사용하는 브라우저의 프로필이나 `.env.http-probe`의 쿠키를 가져오지 않습니다.
- 보안 확인이 나오면 표시된 브라우저에서 사용자가 직접 완료할 수 있도록 최대 120초 기다립니다. 보안 확인을 자동으로 풀거나 자동화 탐지를 숨기는 기능은 없습니다. 제한 시간은 환경변수 `ARCA_SELENIUM_WAIT_SECONDS`(1~600초)로 조정할 수 있습니다.
- 목록이 표시되거나 제한 시간이 지나면 HTML·스크린샷·진단 JSON을 `.local/selenium-probe/`에 저장하고 테스트 브라우저를 종료합니다.
- 일반 게시글 링크를 확인한 경우 기존 파서를 사용한 `*.articles.json`도 저장합니다. 브라우저 접속 성공과 파싱 성공은 진단에서 구분합니다.
- `httpStatus`는 브라우저의 Navigation Timing API가 제공할 때만 기록하며, 제공하지 않으면 `null`입니다. 목록 확인은 상태 코드 대신 실제 DOM의 일반 게시글 링크로 판단합니다.
- Selenium의 보안 확인 통과 여부는 실제 실행 결과로 확인해야 합니다. [Cloudflare의 지원 환경 안내](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)도 참고하세요.
