importScripts("config.js");

console.log("ARCON Extension Guard Started");

// ============================================
// CONSTANTS
// ============================================

const USE_WINDOW_SERVICE = CONFIG.USE_WINDOW_SERVICE;
const ARCON_API_URL = CONFIG.API_URL;
const ARCON_SERVICE_URL = CONFIG.SERVICE_WS_URL;
const SELF_EXTENSION_ID = chrome.runtime.id;

// ============================================
// WEBSOCKET STATE
// ============================================

let arconSocket = null;
let isConnecting = false;
let heartbeatInterval = null;
let reconnectTimer = null;
let isSocketReady = false;
let pendingRequests = new Map();
let requestCounter = 0;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 3000;

// ============================================
// INITIALIZE SOCKET
// ============================================

// Connect immediately when service worker loads
if (USE_WINDOW_SERVICE) {
    connectToArconService();
} else {
    console.log("WebSocket service disabled. Using API only.");
}

// ============================================
// WEBSOCKET FUNCTIONS
// ============================================

function connectToArconService() {
    if (!USE_WINDOW_SERVICE) {
        console.log("WebSocket service is disabled");
        return;
    }

    // Don't connect if already connected or connecting
    if (arconSocket && (arconSocket.readyState === WebSocket.OPEN || arconSocket.readyState === WebSocket.CONNECTING)) {
        console.log("Socket already connected or connecting");
        return;
    }

    if (isConnecting) {
        console.log("Already attempting to connect");
        return;
    }

    isConnecting = true;
    console.log(`Connecting to ARCON Service at: ${ARCON_SERVICE_URL}`);

    try {
        arconSocket = new WebSocket(ARCON_SERVICE_URL);

        arconSocket.onopen = () => {
            console.log("✓ Connected to ARCON Service");
            isConnecting = false;
            isSocketReady = true;
            connectionAttempts = 0;
            
            // Start heartbeat
            startHeartbeat();
            
            // Send any pending messages
            flushPendingMessages();
        };

        arconSocket.onmessage = (event) => {
            try {
                const response = JSON.parse(event.data);
                console.log("Service response received:", response);

                // Handle PONG (heartbeat response)
                if (response.action === "PONG" || response.Action === "PONG") {
                    console.log("Heartbeat acknowledged");
                    return;
                }

                // Handle request responses
                const requestId = response.requestId || response.RequestId;
                if (requestId && pendingRequests.has(requestId)) {
                    const resolve = pendingRequests.get(requestId);
                    pendingRequests.delete(requestId);
                    
                    const allowed = response.allowed !== undefined ? response.allowed : response.Allowed;
                    
                    // Check if this is a validation response
                    if (allowed !== undefined) {
                        resolve({
                            allowed: allowed,
                            message: response.message || response.Message,
                            requestId: requestId
                        });
                    } else {
                        resolve(null);
                    }
                }
            } catch (error) {
                console.error("Invalid Service Response:", error);
            }
        };

        arconSocket.onerror = (error) => {
            console.error("✗ Socket Error:", error);
            isSocketReady = false;
        };

        arconSocket.onclose = (event) => {
            console.warn(`✗ ARCON Service Disconnected (Code: ${event.code})`);
            isConnecting = false;
            isSocketReady = false;
            stopHeartbeat();
            
            // Clear pending requests
            pendingRequests.clear();
            
            // Attempt to reconnect
            scheduleReconnect();
        };

    } catch (error) {
        console.error("Failed to create WebSocket:", error);
        isConnecting = false;
        isSocketReady = false;
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (!USE_WINDOW_SERVICE) return;
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error("Max reconnect attempts reached. Please restart the extension.");
        return;
    }

    const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, connectionAttempts), 30000);
    connectionAttempts++;
    
    console.log(`Scheduling reconnect attempt ${connectionAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    
    reconnectTimer = setTimeout(() => {
        connectToArconService();
    }, delay);
}

function startHeartbeat() {
    if (!USE_WINDOW_SERVICE) return;
    
    stopHeartbeat();

    heartbeatInterval = setInterval(() => {
        if (arconSocket && arconSocket.readyState === WebSocket.OPEN) {
            try {
                arconSocket.send(JSON.stringify({
                    action: "PING",
                    timestamp: new Date().toISOString()
                }));
            } catch (error) {
                console.error("Heartbeat send error:", error);
                isSocketReady = false;
            }
        } else {
            isSocketReady = false;
            if (!isConnecting) {
                connectToArconService();
            }
        }
    }, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function flushPendingMessages() {
    // No need to implement message queue since we're using direct sends
    // But we could add it if needed
}

// ============================================
// SEND TO ARCON FUNCTIONS
// ============================================

async function sendToArcon(payload, parseJson = false) {
    // If using Windows Service, try it first
    if (USE_WINDOW_SERVICE) {
        const serviceResult = await sendToArconService(payload, parseJson);
        if (serviceResult !== null) {
            return serviceResult;
        }
        // If service fails, return null (do NOT fallback to API)
        console.warn("Service returned null - no fallback to API");
        return null;
    }

    // Only use API if explicitly configured (USE_WINDOW_SERVICE = false)
    return await sendToArconApi(payload, parseJson);
}

async function sendToArconApi(payload, parseJson = false) {
    try {
        const response = await fetch(ARCON_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        console.log("API Response Status:", response.status);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        if (parseJson) {
            return await response.json();
        }

        return null;
    } catch (error) {
        console.error("ARCON API error:", error.message);
        return null;
    }
}

function mapToServiceRequest(payload) {
    const normalizedAction = (payload.action || payload.event || "").toString().toUpperCase();
    let action = normalizedAction;

    if (action === "INSTALLED" || action === "ENABLED" || action === "DISABLED" || action === "UNINSTALLED") {
        action = "VALIDATE";
    }

    if (!action && payload.source === "INSTALL_EVENT") {
        action = "VIOLATION";
    }

    return {
        action: action || "VALIDATE",
        extensionId: payload.extension?.id || payload.extensionId || "",
        extensionName: payload.extension?.name || payload.extensionName || "",
        timestamp: payload.timestamp || new Date().toISOString(),
        source: payload.source || payload.event || ""
    };
}

async function sendToArconService(payload, parseJson = false) {
    if (!USE_WINDOW_SERVICE) {
        return null;
    }

    const servicePayload = mapToServiceRequest(payload);
    
    if (!servicePayload.action) {
        return null;
    }

    // Check if socket is ready
    if (!arconSocket || arconSocket.readyState !== WebSocket.OPEN) {
        console.warn("Socket not ready, attempting to connect...");
        if (!isConnecting) {
            connectToArconService();
        }
        // Wait a bit for connection
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!arconSocket || arconSocket.readyState !== WebSocket.OPEN) {
            console.warn("Socket still not ready, skipping service request");
            return null;
        }
    }

    const requestId = (++requestCounter).toString();
    servicePayload.requestId = requestId;

    return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                console.warn(`Request ${requestId} timed out`);
                resolve(null);
            }
        }, 5000);

        pendingRequests.set(requestId, (response) => {
            clearTimeout(timeoutId);
            resolve(response);
        });

        try {
            const jsonPayload = JSON.stringify(servicePayload);
            arconSocket.send(jsonPayload);
            console.log(`Request ${requestId} sent:`, servicePayload.action, "for", servicePayload.extensionId);
        } catch (error) {
            console.error("Error sending to service:", error);
            pendingRequests.delete(requestId);
            clearTimeout(timeoutId);
            resolve(null);
        }
    });
}

// ============================================
// EXTENSION MANAGEMENT FUNCTIONS
// ============================================

function getAllExtensions() {
    return new Promise((resolve, reject) => {
        chrome.management.getAll((extensions) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(extensions);
            }
        });
    });
}

function setExtensionEnabled(id, enabled) {
    return new Promise((resolve, reject) => {
        chrome.management.setEnabled(id, enabled, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve();
            }
        });
    });
}

function uninstallExtension(id) {
    return new Promise((resolve, reject) => {
        chrome.management.uninstall(id, { showConfirmDialog: false }, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve();
            }
        });
    });
}

// ============================================
// EXTENSION VALIDATION
// ============================================

async function validateExtension(extension) {
    const result = await sendToArcon(
        {
            event: "VALIDATE",
            timestamp: new Date().toISOString(),
            extension: extension
        },
        true
    );

    // If no result, default to NOT allowed (block)
    if (!result) {
        console.warn(`No validation response for ${extension.name}, blocking by default`);
        return { allowed: false, extensionName: extension.name, reason: "No response" };
    }

    // Check if the response has an 'allowed' field
    if (result.allowed === undefined) {
        console.warn(`Validation response missing 'allowed' field for ${extension.name}`);
        return { allowed: false, extensionName: extension.name, reason: "Invalid response" };
    }

    console.log(`Validation for ${extension.name}: allowed = ${result.allowed}`);
    return result;
}

async function enforceExtension(extension, validationResult) {
    if (extension.id === SELF_EXTENSION_ID) {
        console.log("Skipping self-extension:", extension.name);
        return;
    }

    // Only allow if explicitly true
    if (validationResult.allowed !== true) {
        const message = `${extension.name} is not approved`;
        console.warn("🚫 UNAUTHORIZED EXTENSION:", extension.name, extension.id);
        console.warn("Reason:", validationResult.reason || "Not approved");

        // Show notification
        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "ARCON Security Alert",
            message: message,
            priority: 2
        });

        // Disable the extension if possible
        if (extension.enabled && extension.mayDisable) {
            try {
                await setExtensionEnabled(extension.id, false);
                console.log(`✓ Disabled unauthorized extension: ${extension.name}`);
            } catch (disableError) {
                console.warn(`✗ Could not disable ${extension.name}:`, disableError);
            }
        }

        // Try to uninstall the extension
        try {
            await uninstallExtension(extension.id);
            console.log(`✓ Uninstalled unauthorized extension: ${extension.name}`);
        } catch (uninstallError) {
            console.warn(`✗ Could not uninstall ${extension.name}:`, uninstallError);
        }
    } else {
        console.log(`✅ Extension ${extension.name} is approved`);
    }
}

async function processExtension(extension) {
    if (!extension || extension.id === SELF_EXTENSION_ID) {
        return;
    }

    const validation = await validateExtension(extension);
    await enforceExtension(extension, validation);
}

async function scanExtensions() {
    try {
        const extensions = await getAllExtensions();
        console.log("Total Extensions Found:", extensions.length);

        for (const extension of extensions) {
            await processExtension(extension);
        }
    } catch (error) {
        console.error("Error scanning extensions:", error);
    }
}

// ============================================
// EVENT LISTENERS
// ============================================

// Extension Installed
chrome.management.onInstalled.addListener(async function (extension) {
    console.log("NEW EXTENSION DETECTED:", extension.name);
    
    await sendToArcon({
        event: "INSTALLED",
        timestamp: new Date().toISOString(),
        extension: extension
    });
    
    await sendViolation(extension);
    await processExtension(extension);
});

// Extension Enabled
chrome.management.onEnabled.addListener(async function (extension) {
    console.log("Extension Enabled:", extension.name);
    
    await sendToArcon({
        event: "ENABLED",
        timestamp: new Date().toISOString(),
        extension: extension
    });
    
    await processExtension(extension);
});

// Extension Disabled
chrome.management.onDisabled.addListener(async function (extension) {
    console.log("Extension Disabled:", extension.name);
    
    await sendToArcon({
        event: "DISABLED",
        timestamp: new Date().toISOString(),
        extension: extension
    });
});

// Extension Uninstalled
chrome.management.onUninstalled.addListener(async function (extensionId) {
    console.log("Extension Removed:", extensionId);
    
    await sendToArcon({
        event: "UNINSTALLED",
        timestamp: new Date().toISOString(),
        extensionId: extensionId
    });
});

// Send Violation
async function sendViolation(extension) {
    try {
        await sendToArcon({
            action: "VIOLATION",
            extensionId: extension.id,
            extensionName: extension.name,
            timestamp: new Date().toISOString(),
            source: "INSTALL_EVENT"
        });
    } catch (error) {
        console.error("Violation messaging error:", error);
    }
}

// ============================================
// CHROME EVENTS
// ============================================

// Chrome Startup
chrome.runtime.onStartup.addListener(async function () {
    console.log("Chrome Started");
    if (USE_WINDOW_SERVICE) {
        connectToArconService();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await scanExtensions();
});

// Extension Installed
chrome.runtime.onInstalled.addListener(async function () {
    console.log("ARCON Extension Installed");
    if (USE_WINDOW_SERVICE) {
        connectToArconService();
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await scanExtensions();
});

// ============================================
// PERIODIC SCAN
// ============================================

chrome.alarms.create("extensionScan", {
    periodInMinutes: 1
});

chrome.alarms.onAlarm.addListener(async function (alarm) {
    if (alarm.name === "extensionScan") {
        await scanExtensions();
    }
});

// ============================================
// CLEANUP
// ============================================

chrome.runtime.onSuspend.addListener(function () {
    console.log("ARCON Extension suspending...");
    stopHeartbeat();
    
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (arconSocket) {
        try {
            arconSocket.close();
        } catch (e) {
            // Ignore
        }
        arconSocket = null;
    }
    
    pendingRequests.clear();
    isConnecting = false;
    isSocketReady = false;
});