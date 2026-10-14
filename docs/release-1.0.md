# 핫딜 수집 관리자 1.0.0

Windows x64용 개인용 핫딜 수집 앱입니다. 아카라이브 공식 앱이 아닙니다.

## 설치 및 첫 실행

1. Google Chrome이 설치되어 있는지 확인합니다. 앱에는 Electron과 Node.js가 포함되어 있어 Node.js·npm을 별도로 설치할 필요가 없습니다.
2. `HotdealCollector-Setup-1.0.0-x64.exe`를 실행하고 설치 폴더를 선택합니다. 현재 Windows 사용자 계정에 설치합니다.
3. **핫딜 수집 관리자**를 열고 **서버 시작**을 누릅니다. 처음 실행할 때 Selenium Manager가 Chrome에 맞는 드라이버를 내려받으므로 인터넷 연결이 필요합니다.
4. 기본 3분마다 Chrome 창 없이 핫딜 목록을 수집하고 JSON으로 저장합니다. 수집한 글은 **핫딜 목록**에서 확인합니다.

앱 창을 닫거나 최소화하면 트레이로 숨겨지고 수집은 계속됩니다. 완전히 종료하려면 트레이 아이콘을 우클릭하여 **앱 완전 종료**를 선택합니다.

## 1.0 기능

- 서버 시작·중지, 지금 수집, 수집 간격 변경, User-Agent 설정
- 게시글 JSON 저장, 공지 제외, 중복 병합, 목록 및 원문 열기
- 상태·로그 확인, 시스템 트레이
- 새 글 플로팅 알림과 소리, 알림 설정, 오른쪽 드래그로 닫기 및 복귀 애니메이션
- Windows 로그인 시 트레이에서 앱과 서버 자동 실행
- `http://127.0.0.1:38471`에서 다른 프론트엔드가 이용할 수 있는 로컬 JSON API

자동 실행은 **설정 → 시작**에서 직접 켭니다. 로그인 시 실행하는 기능이며, 사용자가 로그인하기 전 실행되는 Windows 서비스는 아닙니다. 앱 위치를 옮긴 경우 자동 실행을 끄고 다시 켜세요.

## 데이터 및 기존 개발판

설치판 데이터는 `%APPDATA%\HotdealCollector`에 저장합니다.

- `collector\articles.json`: 수집 게시글
- `collector\settings.json`: 수집 간격
- `collector\browser-settings.json`: User-Agent
- `collector\profile`, `collector\driver-cache`: 수집 전용 브라우저 프로필 및 드라이버
- `notification-settings.json`: 알림 설정

**설정 → 수집 → 저장 폴더 열기**로 실제 저장 위치를 확인할 수 있습니다. 앱 업데이트·제거 시 저장 데이터를 자동 삭제하지 않습니다.

기존 프로젝트 `.local` 데이터와 `.env`는 설치 파일에 포함하지 않습니다. 설치판은 새 저장 폴더로 시작합니다. 이전 데이터를 이어 쓰려면 개발판 서버와 설치판을 모두 종료한 뒤 `.local\selenium-server`의 `articles.json`, `settings.json`, `browser-settings.json`만 설치판 `collector` 폴더로 복사할 수 있습니다. 알림 설정은 `.local\desktop\notification-settings.json`을 설치판 데이터 폴더로 복사합니다. 프로필·드라이버 캐시는 새로 생성합니다.

개발판과 설치판은 기본 API 포트가 같습니다. 개발판 서버를 먼저 종료하고 설치판 서버를 시작하세요. 개발판에서 켜 둔 Windows 자동 실행은 먼저 끈 뒤 설치판에서 켜는 것이 좋습니다.

고급 실행 환경변수 `HOTDEAL_USER_DATA_DIR`로 앱 데이터 폴더를 지정할 수 있습니다. `DATA_DIR`, `PORT`, `FRONTEND_ORIGINS` 등 서버 환경변수도 지원합니다. 설치판은 프로젝트 `.env`를 읽지 않습니다.

## 배포 및 동작 범위

현재 설치 파일은 코드 서명이 없어 Windows에서 게시자를 확인할 수 없다는 메시지가 표시될 수 있습니다. 설치 파일과 `SHA256SUMS.txt`를 함께 배포합니다. 별도의 인증서·자동 업데이트 기능은 포함하지 않습니다.

수집은 첫 페이지의 목록을 설정한 간격으로 확인합니다. 수집 사이에 첫 페이지 밖으로 밀려난 글은 누락될 수 있습니다. 사이트 구조·Chrome 버전·사이트의 접속 확인 정책이 변경되면 수집이 실패할 수 있으며, 실패 시 기존 JSON을 유지하고 로그에 오류를 표시합니다.

## 개발자용 빌드

```powershell
pnpm install --frozen-lockfile
pnpm desktop:install
pnpm test
pnpm dist:win
```

`release`에 설치 파일·SHA-256 체크섬·`win-unpacked`가 생성됩니다. 빌드 후 개인 설정 제외와 Selenium 실행 파일·고지 파일 포함 여부를 자동 검사합니다. `--publish never`로 외부에 자동 업로드하지 않습니다. 공개 배포에는 설치 `.exe`와 체크섬, 사용 안내서를 사용하며 개발 프로젝트나 `.local` 폴더를 보내지 않습니다.

패키징 관련 공식 문서: [Electron ASAR 제한 사항](https://www.electronjs.org/docs/latest/tutorial/asar-archives), [electron-builder NSIS](https://www.electron.build/nsis/).
