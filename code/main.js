const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const Store = require('electron-store');
const path = require('path');

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
    console.log('active-win 로드 성공');
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
    'notepad.exe',
    'slack.exe',
    'discord.exe',
    'EXCEL.EXE',
    'Photoshop.exe',
    'Illustrator.exe',
    'figma.exe',
  ];
}

// 모니터링 시작
function startMonitoring() {
  if (isMonitoring) return;
  
  isMonitoring = true;
  isUserActive = false;
  
  console.log('모니터링 시작');
  
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
      console.log('uIOhook 키보드/마우스 입력 감지 활성화)');
    } else {
      console.log('uIOhook 오류');
      isUserActive = true;
    }
  } catch (error) {
    console.log('uIOhook 없음', error.message);
    isUserActive = true;
  }
  
  // 프로그램 체크 (1초마다)
  monitoringInterval = setInterval(async () => {
    try {
      if (!activeWin) {
        console.log('active-win 오류');
        return;
      }

      const activeWindow = await activeWin();
      
      if (activeWindow) {
        const currentProgram = activeWindow.owner.name || '';
        
      
        const isSelectedProgram = selectedPrograms.some(program => {
          const cleanProgram = program.toLowerCase().replace(/\.exe$/i, '').trim();
          const cleanCurrent = currentProgram.toLowerCase().replace(/\.exe$/i, '').trim();
          
          if (cleanCurrent === cleanProgram) return true;
          if (cleanCurrent.includes(cleanProgram)) return true;
          if (cleanProgram.includes(cleanCurrent)) return true;
          
          return false;
        });
        
        // 활동중이면 타이머 작동
        if (isSelectedProgram && isUserActive) {
          mainWindow.webContents.send('timer-tick', true, currentProgram);
        } else {
          // 타이머 정지
          mainWindow.webContents.send('timer-tick', false, currentProgram);
        }
      } else {
      
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
  
  console.log('모니터링 중지');
}

// 사용자 활동 감지
function onUserActivity() {
  if (!isMonitoring) return;
  
  const wasActive = isUserActive;
  isUserActive = true;
  
  if (activityTimeout) {
    clearTimeout(activityTimeout);
    activityTimeout = null;
  }
  
  // 5초 후 비활성화
  activityTimeout = setTimeout(() => {
    isUserActive = false;
    console.log('활동 정지');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('timer-tick', false, '');
    }
  }, 5000);
  
  if (!wasActive) {
    console.log('사용자 활동 감지, 타이머 시작');
  }
}

app.whenReady().then(async () => {
  await loadActiveWin(); 
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
    return;
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
    movable: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });
  const imagePath = path.join(__dirname, 'asset', 'img', 'cat-walk1.png');
  let imageUrl;
  if (process.platform === 'win32') {
    imageUrl = 'file:///' + imagePath.replace(/\\/g, '/');
  } else {
    imageUrl = 'file://' + imagePath;
  }
  
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
          user-select: none;
          pointer-events: auto;
          overflow: visible;
          position: relative;
          -webkit-app-region: drag; 
        }
        #pet {
          width: 80px;
          height: 80px;
          object-fit: contain;
          transition: transform 0.1s;
          cursor: move;
          -webkit-app-region: no-drag; 
        }
        #speech {
          position: absolute;
          top: -30px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(255, 255, 255, 0.95);
          color: #333;
          padding: 5px 10px;
          border-radius: 10px;
          font-size: 12px;
          white-space: nowrap;
          display: none;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          z-index: 1000;
          pointer-events: none;
        }
        #speech.show {
          display: block;
          animation: fadeInOut 2s ease;
        }
        @keyframes fadeInOut {
          0%, 100% { opacity: 0; transform: translateX(-50%) translateY(5px); }
          20%, 80% { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      </style>
    </head>
    <body>
      <img id="pet" src="${imageUrl}" alt="Roaming Pet">
      <div id="speech"></div>
    </body>
    </html>
  `;

  roamingWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(roamingHTML));


  roamingWindow.webContents.on('did-finish-load', () => {
    const messages = ['Meow~', 'Keep working hard!', 'You\'re doing great!', 'Cheer up!', 'Good job!'];
    

    setTimeout(() => {
      roamingWindow.webContents.executeJavaScript(`
        (function() {
          const messages = ${JSON.stringify(messages)};
          let speechTimeout = null;
          
          function showSpeech() {
            const speech = document.getElementById('speech');
            if (!speech) {
              console.log('Speech element 없음음');
              return;
            }
            
            if (speechTimeout) {
              clearTimeout(speechTimeout);
            }
            
            const randomMsg = messages[Math.floor(Math.random() * messages.length)];
            speech.textContent = randomMsg;
            speech.classList.remove('show');
            
            speech.offsetHeight;
            
            setTimeout(() => {
              speech.classList.add('show');
              speechTimeout = setTimeout(() => {
                speech.classList.remove('show');
              }, 2000);
            }, 10);
          }
          
          const pet = document.getElementById('pet');
          if (pet) {
            pet.addEventListener('click', function(e) {
              e.stopPropagation();
              showSpeech();
            });
            pet.addEventListener('mousedown', function(e) {
              e.stopPropagation();
            });
            pet.style.cursor = 'move';

            pet.style.transform = 'scaleX(1)';
            console.log('Click 이벤트 리스너 추가');
          } else {
            console.log('Pet element not found');
          }
        })();
      `).then(() => {
        console.log('Roaming pet click event script executed');
      }).catch(err => {
        console.error('Roaming pet click event error:', err);
      });
    }, 100);
  });

  // 초기 위치 설정
  let currentX = Math.random() * (width - 100);
  let currentY = Math.random() * (height - 100);
  let targetX = Math.random() * (width - 100);
  let targetY = Math.random() * (height - 100);
  const speed = 2;

  roamingWindow.setPosition(Math.round(currentX), Math.round(currentY));
  roamingWindow.show();

  // 이동 로직
  let lastDirection = 1; // 1: 오른쪽, -1: 왼쪽
  roamingInterval = setInterval(() => {
    if (!roamingWindow || roamingWindow.isDestroyed()) {
      clearInterval(roamingInterval);
      return;
    }

    const dx = targetX - currentX;
    const dy = targetY - currentY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 10) {
      targetX = Math.random() * (width - 100);
      targetY = Math.random() * (height - 100);
    } else {
      currentX += (dx / distance) * speed;
      currentY += (dy / distance) * speed;

      // 이동 방향에 따라 이미지 반전
      if (Math.abs(dx) > 0.1) { 
        const newDirection = dx < 0 ? 1 : -1; // 1: 기본값, -1: 반전
        if (newDirection !== lastDirection) {
          lastDirection = newDirection;
          const transformValue = newDirection === -1 ? 'scaleX(-1)' : 'scaleX(1)';
          roamingWindow.webContents.executeJavaScript(`
            (function() {
              const pet = document.getElementById('pet');
              if (pet) {
                pet.style.transform = '${transformValue}';
                pet.style.webkitTransform = '${transformValue}';
              }
            })();
          `).catch(err => {
            setTimeout(() => {
              roamingWindow.webContents.executeJavaScript(`
                const pet = document.getElementById('pet');
                if (pet) {
                  pet.style.transform = '${transformValue}';
                }
              `).catch(e => console.log('Image flip retry error:', e));
            }, 50);
          });
        }
      }

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