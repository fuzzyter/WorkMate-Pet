const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const Store = require('electron-store');

let activeWin;

const store = new Store();
let mainWindow;
let roamingWindow = null;
let monitoringInterval = null;
let selectedPrograms = [];
let isMonitoring = false;
let isUserActive = false;
let activityTimeout = null;
let uIOhook = null;
let roamingInterval = null;

// active-win 로드
async function loadActiveWin() {
  try {
    const module = await import('active-win');
    activeWin = module.default;
    console.log('active-win 로드 성공!');
  } catch (error) {
    console.error('active-win 로드 실패:', error);
  }
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // 저장된 프로그램 목록 불러오기
  selectedPrograms = store.get('selectedPrograms', []);
  
  // 창에 전달
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('load-selected-programs', selectedPrograms);
  });

  // 닫기/최소화
  ipcMain.on('window-close', () => {
    stopMonitoring();
    mainWindow.close();
  });

  ipcMain.on('window-minimize', () => {
    mainWindow.minimize();
  });

  // 설치된 모든 프로그램 목록 가져오기
  ipcMain.handle('get-all-programs', async () => {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        const { exec } = require('child_process');
        exec('wmic process get description', (error, stdout) => {
          if (error) {
            console.error('프로그램 목록 에러:', error);
            resolve(getDefaultPrograms());
            return;
          }
          
          const lines = stdout.split('\n');
          const programs = new Set();
          
          lines.forEach(line => {
            const programName = line.trim();
            if (programName && 
                programName !== 'Description' &&
                programName.includes('.exe') &&
                !programName.toLowerCase().includes('system') &&
                !programName.toLowerCase().includes('svchost')) {
              programs.add(programName);
            }
          });
          
          // 자주 쓰는 프로그램 추가
          const commonPrograms = getDefaultPrograms();
          commonPrograms.forEach(prog => programs.add(prog));
          
          resolve(Array.from(programs).sort());
        });
      } else {
        resolve(['Google Chrome.app', 'Visual Studio Code.app', 'Notion.app']);
      }
    });
  });

  // 선택된 프로그램 저장
  ipcMain.on('set-selected-programs', (event, programs) => {
    selectedPrograms = programs;
    store.set('selectedPrograms', programs);
    console.log('선택된 프로그램 저장:', selectedPrograms);
  });

  // 모니터링 시작
  ipcMain.on('start-monitoring', () => {
    startMonitoring();
  });

  // 모니터링 중지
  ipcMain.on('stop-monitoring', () => {
    stopMonitoring();
  });

  // 시메지 활성화/비활성화
  ipcMain.on('toggle-roaming', (event, enable, petEmoji) => {
    if (enable) {
      createRoamingWindow(petEmoji);
    } else {
      closeRoamingWindow();
    }
  });

  // 시메지 위치 업데이트
  ipcMain.on('update-roaming-position', (event, x, y) => {
    if (roamingWindow && !roamingWindow.isDestroyed()) {
      roamingWindow.setPosition(Math.round(x), Math.round(y));
    }
  });
}

// 기본 프로그램 목록
function getDefaultPrograms() {
  return [
    'chrome.exe',
    'firefox.exe',
    'msedge.exe',
    'Code.exe',
    'notepad++.exe',
    'Notion.exe',
    'slack.exe',
    'discord.exe',
    'EXCEL.EXE',
    'WINWORD.EXE',
    'POWERPNT.EXE',
    'Photoshop.exe',
    'Illustrator.exe',
    'figma.exe',
    'obs64.exe',
    'Spotify.exe'
  ];
}

// 모니터링 시작
function startMonitoring() {
  if (isMonitoring) return;
  
  isMonitoring = true;
  isUserActive = false;
  
  console.log('모니터링 시작!');
  
  // uiohook-napi 로드
  try {
    const uiohookModule = require('uiohook-napi');
    uIOhook = uiohookModule.uIOhook || uiohookModule.default || uiohookModule;
    
    if (uIOhook && typeof uIOhook.on === 'function') {
      // 키보드 입력 감지
      uIOhook.on('keydown', () => {
        onUserActivity();
      });
      
      // 마우스 클릭 감지
      uIOhook.on('click', () => {
        onUserActivity();
      });
      
      // 마우스 휠 감지
      uIOhook.on('wheel', () => {
        onUserActivity();
      });
      
      uIOhook.start();
      console.log('uIOhook 시작됨! (키보드/마우스 입력 감지 활성화)');
    } else {
      console.log('uIOhook 모듈을 찾을 수 없거나 올바르지 않습니다.');
      isUserActive = true;
    }
  } catch (error) {
    console.log('uIOhook 없음, 기본 모드로 전환:', error.message);
    // uIOhook 없으면 프로그램 활성화만으로 판단
    isUserActive = true;
  }
  
  // 프로그램 체크 (1초마다)
  monitoringInterval = setInterval(async () => {
    try {
      if (!activeWin) {
        console.log('active-win이 아직 로드되지 않음');
        return;
      }

      const activeWindow = await activeWin();
      
      if (activeWindow) {
        const currentProgram = activeWindow.owner.name || '';
        
        // 선택된 프로그램인지 확인 (더 정확한 매칭)
        const isSelectedProgram = selectedPrograms.some(program => {
          const cleanProgram = program.toLowerCase().replace(/\.exe$/i, '').trim();
          const cleanCurrent = currentProgram.toLowerCase().replace(/\.exe$/i, '').trim();
          
          // 정확히 일치하거나, 한쪽이 다른 쪽을 포함하는 경우
          if (cleanCurrent === cleanProgram) return true;
          if (cleanCurrent.includes(cleanProgram)) return true;
          if (cleanProgram.includes(cleanCurrent)) return true;
          
          return false;
        });
        
        // 선택된 프로그램 + 활동 중 = 타이머 증가
        if (isSelectedProgram && isUserActive) {
          mainWindow.webContents.send('timer-tick', true, currentProgram);
        } else {
          // 선택된 프로그램이 아니거나 활동이 없으면 타이머 정지
          mainWindow.webContents.send('timer-tick', false, currentProgram);
        }
      } else {
        // 활성 창이 없으면 타이머 정지
        mainWindow.webContents.send('timer-tick', false, '');
      }
    } catch (error) {
      console.error('모니터링 에러:', error);
    }
  }, 1000);
}

// 모니터링 중지
function stopMonitoring() {
  if (!isMonitoring) return;
  
  isMonitoring = false;
  
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  
  if (activityTimeout) {
    clearTimeout(activityTimeout);
    activityTimeout = null;
  }
  
  // uIOhook 중지
  if (uIOhook) {
    try {
      uIOhook.stop();
      uIOhook = null;
    } catch (error) {
      console.log('uIOhook 중지 에러:', error.message);
    }
  }
  
  console.log('모니터링 중지!');
}

// 사용자 활동 감지
function onUserActivity() {
  if (!isMonitoring) return;
  
  const wasActive = isUserActive;
  isUserActive = true;
  
  // 기존 타임아웃 제거
  if (activityTimeout) {
    clearTimeout(activityTimeout);
    activityTimeout = null;
  }
  
  // 5초 후 비활성화
  activityTimeout = setTimeout(() => {
    isUserActive = false;
    console.log('사용자 활동 중지 (5초 경과)');
    // 활동이 중지되었음을 UI에 알림
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-tick', false, '');
    }
  }, 5000);
  
  // 비활성 상태에서 활성 상태로 전환된 경우 로그
  if (!wasActive) {
    console.log('사용자 활동 감지됨 - 타이머 시작');
  }
}

app.whenReady().then(async () => {
  await loadActiveWin(); // active-win 먼저 로드
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  stopMonitoring();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopMonitoring();
  closeRoamingWindow();
});

// 시메지 창 생성
function createRoamingWindow(petEmoji) {
  if (roamingWindow) {
    return; // 이미 열려있으면 무시
  }

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  roamingWindow = new BrowserWindow({
    width: 100,
    height: 100,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // HTML 생성
  const roamingHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          background: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 60px;
          user-select: none;
          pointer-events: none;
          overflow: hidden;
        }
        #pet {
          text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }
      </style>
    </head>
    <body>
      <div id="pet">${petEmoji || '🐱'}</div>
    </body>
    </html>
  `;

  roamingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(roamingHTML));

  // 초기 위치 설정
  let currentX = Math.random() * (width - 100);
  let currentY = Math.random() * (height - 100);
  let targetX = Math.random() * (width - 100);
  let targetY = Math.random() * (height - 100);
  const speed = 2;

  roamingWindow.setPosition(Math.round(currentX), Math.round(currentY));
  roamingWindow.show();

  // 이동 로직
  roamingInterval = setInterval(() => {
    if (!roamingWindow || roamingWindow.isDestroyed()) {
      clearInterval(roamingInterval);
      return;
    }

    const dx = targetX - currentX;
    const dy = targetY - currentY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 10) {
      // 목표 지점 도달, 새로운 목표 설정
      targetX = Math.random() * (width - 100);
      targetY = Math.random() * (height - 100);
    } else {
      // 목표 지점으로 이동
      currentX += (dx / distance) * speed;
      currentY += (dy / distance) * speed;

      // 화면 경계 체크
      if (currentX < 0) currentX = 0;
      if (currentX > width - 100) currentX = width - 100;
      if (currentY < 0) currentY = 0;
      if (currentY > height - 100) currentY = height - 100;

      roamingWindow.setPosition(Math.round(currentX), Math.round(currentY));
    }
  }, 50);
}

// 시메지 창 닫기
function closeRoamingWindow() {
  if (roamingInterval) {
    clearInterval(roamingInterval);
    roamingInterval = null;
  }
  if (roamingWindow) {
    roamingWindow.close();
    roamingWindow = null;
  }
}