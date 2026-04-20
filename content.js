const idsProcessedOne = new Set();
const idsProcessedTwo = new Set();
const idsProcessedThree = new Set();


function applyStylesToLastElement() {
    const logDivs = document.querySelectorAll('section[role="feed"]');

    logDivs.forEach(logDiv => {
        
        const ticketTab = logDiv.closest('.conversation-polaris');
        const ticketTabId = ticketTab?.getAttribute('data-ticket-id');
        const timeElementsRelative = logDiv.querySelectorAll('time[data-test-id="timestamp-relative"]');
       
        const lastTimeElementRelative = timeElementsRelative[timeElementsRelative.length - 1] || null;

        const timeElementsAbsolute = logDiv.querySelectorAll('time[data-test-id="timestamp-absolute"]');
        
        const lastTimeElementAbsolute = timeElementsAbsolute[timeElementsAbsolute.length - 1] || null;


        const myTimeElement =
            lastTimeElementRelative && lastTimeElementAbsolute
                ? getNearestTimestamp(lastTimeElementRelative, lastTimeElementAbsolute)
                : (lastTimeElementRelative || lastTimeElementAbsolute);

        if (myTimeElement && ticketTabId) {
            checkTimestamp(myTimeElement, ticketTabId);
        }
    

    });
}

function getNearestTimestamp(time1, time2) {
    if (!time1) return time2;
    if (!time2) return time1;
    const datetime1 = time1.getAttribute('datetime');
    const datetime2 = time2.getAttribute('datetime');
    if (!datetime1) return time2;
    if (!datetime2) return time1;
    const date1 = new Date(datetime1);
    const date2 = new Date(datetime2);
    const now = new Date();
    const diff1 = Math.abs(now - date1);
    const diff2 = Math.abs(now - date2);
    if (diff1 < diff2) {
        return time1;
    } else {
        return time2;
    }
}

function checkTimestamp(element, id) {
    if (!element || !id) return;
    const datetime = element.getAttribute('datetime');
    if (!datetime) return;
    const date = new Date(datetime);
    const now = new Date();
    const diff = now - date;
    const diffMinutes = diff / (1000 * 60);    
    const tab = document.querySelector(`[role="tab"][data-entity-id="${id}"]`);
    changeTime(tab, diffMinutes);
    const messageType = checkType(id);
    changeBackgroundColor(tab, id, messageType, diffMinutes);
         
}

function changeTime(tab, time) {
    if (tab) {
        let checkIfSpan = tab.querySelector('span.minhaClasse') || null
        const divToInputSpan = tab.querySelector(`[data-test-id="header-non-chat-tab-avatar"]`)
        if (tab && !checkIfSpan) {
            const novoSpan = document.createElement("span");
            novoSpan.className = "minhaClasse";
            novoSpan.style.margin = "12px";
            novoSpan.style.color = "black";
            novoSpan.style.fontWeight = "bold";
            novoSpan.textContent = Math.floor(time);
            divToInputSpan.appendChild(novoSpan);
        } else if(tab && checkIfSpan){
            checkIfSpan.textContent = '';
            checkIfSpan.textContent = Math.floor(time);

        }
    }
}


function checkType(id) {
        const conversationDiv = document.querySelector(`div[data-side-conversations-anchor-id="${id}"]`);
        const section = conversationDiv?.querySelector('section');
        const lastMessage = section
            ? [...section.querySelectorAll('article [data-test-id="omni-log-item-message"]')].pop()
            : null;
        return lastMessage?.getAttribute('type');
    }




function changeBackgroundColor(tab, id, type, diffMinutes) {
    if (!tab) return;

    const defaultBackground =
        document.documentElement?.dataset?.theme === 'dark'
            ? 'rgba(var(--grey-1100), var(--opacity-max))'
            : 'rgba(var(--white), var(--opacity-max))';

    switch (true) {
        case diffMinutes >= 10:
           tab.style.background = 'rgba(255, 0, 0, 0.45)'
          if (!idsProcessedTwo.has(id)) {
            playSound();
            idsProcessedTwo.add(id);
          }
          break;
      
        case diffMinutes >= 5 && diffMinutes < 10 && type === "agent":
           tab.style.background = 'rgba(0, 217, 255, 0.45)'
          if (!idsProcessedOne.has(id)) {
            playSound();
            idsProcessedOne.add(id);
          }
          break;
      
        case diffMinutes >= 1 && diffMinutes < 10 && type === "end-user":
            tab.style.background = 'rgb(255, 255, 0)';
            if (!idsProcessedThree.has(id)) {
                playSound();
                idsProcessedThree.add(id);
          }
          break;
      
        default:
           tab.style.background = defaultBackground;
      }
    
}



function playSound() {
    var audio = new Audio('https://sdk.twilio.com/js/client/sounds/releases/1.0.0/outgoing.mp3');

   
    audio.play();
    setTimeout(function() {
        audio.pause();
        audio.currentTime = 0;
    }, 2000); // 2000 milissegundos = 2 segundos
}




applyStylesToLastElement();

setInterval(applyStylesToLastElement, 1000); // 1000 milissegundos = 1 segundo
