importScripts("config.js");

console.log("ARCON Extension Guard Started");

const USE_WINDOW_SERVICE = CONFIG.USE_WINDOW_SERVICE;
const ARCON_API_URL = CONFIG.API_URL;
const ARCON_SERVICE_URL = CONFIG.SERVICE_WS_URL;
const SELF_EXTENSION_ID = chrome.runtime.id;

let arconSocket = null;
let isConnecting = false;

function getAllExtensions() {
    return new Promise((resolve, reject) => {
        chrome.management.getAll((extensions) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            }
            else {
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
            }
            else {
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
            }
            else {
                resolve();
            }
        });
    });
}

/*
------------------------------------------------
UTILITY FUNCTION
Send data to ARCON backend
------------------------------------------------
*/

async function sendToArcon(payload, parseJson = false) {
    if (USE_WINDOW_SERVICE) {
        const serviceResult = await sendToArconService(payload, parseJson);
        if (serviceResult !== null) {
            return serviceResult;
        }
    }

    return await sendToArconApi(payload, parseJson);
}

async function sendToArconApi(payload, parseJson = false) {
    try {
        const response = await fetch(
            ARCON_API_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

        console.log("Response Status:", response.status);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        if (parseJson) {
            return await response.json();
        }

        return null;
    }
    catch (error) {
        console.error("ARCON API error:", error.message, error);
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
        action,
        extensionId: payload.extension?.id || payload.extensionId || "",
        extensionName: payload.extension?.name || payload.extensionName || "",
        timestamp: payload.timestamp || new Date().toISOString(),
        source: payload.source || payload.event || ""
    };
}

async function sendToArconService(payload, parseJson = false) {
    const servicePayload = mapToServiceRequest(payload);
    if (!servicePayload.action) {
        return null;
    }

    return new Promise((resolve) => {
        const socket = new WebSocket(ARCON_SERVICE_URL);
        let resolved = false;

        const finish = async (result, fallback = false) => {
            if (!resolved) {
                resolved = true;
                try {
                    socket.close();
                }
                catch { }

                resolve(fallback ? null : result);
            }
        };

        socket.onopen = () => {
            socket.send(JSON.stringify(servicePayload));
        };

        socket.onmessage = (event) => {
            if (parseJson) {
                try {
                    finish(JSON.parse(event.data));
                }
                catch (error) {
                    console.error("ARCON service invalid JSON:", error);
                    finish(null, true);
                }
            }
            else {
                finish(undefined);
            }
        };

        socket.onerror = async (event) => {
            console.error("ARCON service socket error", event);
            const fallbackResult = await sendToArconApi(payload, parseJson);
            finish(fallbackResult, true);
        };

        socket.onclose = () => {
            if (!resolved) {
                finish(undefined);
            }
        };

        setTimeout(() => {
            if (!resolved) {
                console.warn("ARCON service socket timed out");
                finish(null, true);
            }
        }, 5000);
    });
}

/*
------------------------------------------------
FULL EXTENSION SCAN
Gets all installed extensions
------------------------------------------------
*/

async function validateExtension(extension) {
    const result = await sendToArcon(
        {
            event: "VALIDATE",
            timestamp: new Date().toISOString(),
            extension: extension
        },
        true);

    if (!result) {
        return { allowed: true, extensionName: extension.name };
    }

    return result;
}

async function enforceExtension(extension, validationResult) {
    if (extension.id === SELF_EXTENSION_ID) {
        return;
    }

    if (!validationResult.allowed) {
        const message = `${extension.name} is not approved`;
        console.warn("UNAUTHORIZED EXTENSION:", extension.name, extension.id);

        chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "ARCON Security",
            message: message
        });

        if (extension.enabled && extension.mayDisable) {
            try {
                await setExtensionEnabled(extension.id, false);
                console.log(`Disabled unauthorized extension: ${extension.name}`);
            }
            catch (disableError) {
                console.warn(`Could not disable ${extension.name}:`, disableError);
            }
        }

        try {
            await uninstallExtension(extension.id);
            console.log(`Uninstalled unauthorized extension: ${extension.name}`);
        }
        catch (uninstallError) {
            console.warn(`Could not uninstall ${extension.name}:`, uninstallError);
        }
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
    chrome.management.getAll(async function (extensions) {
        console.log("Total Extensions Found:", extensions.length);

        for (const extension of extensions) {
            await processExtension(extension);
        }
    });
}

/*
------------------------------------------------
EVENT:
Extension Installed
------------------------------------------------
*/

chrome.management.onInstalled
    .addListener(
        async function (extension) {
            console.log(
                "NEW EXTENSION DETECTED:",
                extension.name);

            await sendToArcon(
                {
                    event:
                        "INSTALLED",

                    timestamp:
                        new Date().toISOString(),

                    extension:
                        extension
                });

            await sendViolation(extension);
            await processExtension(extension);
        });

/*
------------------------------------------------
EVENT:
Extension Enabled
------------------------------------------------
*/

chrome.management.onEnabled
    .addListener(
        async function (extension) {
            console.log(
                "Extension Enabled:",
                extension.name);

            await sendToArcon(
                {
                    event:
                        "ENABLED",

                    timestamp:
                        new Date().toISOString(),

                    extension:
                        extension
                });

            await processExtension(extension);
        });

/*
------------------------------------------------
EVENT:
Extension Disabled
------------------------------------------------
*/

chrome.management.onDisabled
    .addListener(
        async function (extension) {
            console.log(
                "Extension Disabled:",
                extension.name);

            await sendToArcon(
                {
                    event:
                        "DISABLED",

                    timestamp:
                        new Date().toISOString(),

                    extension:
                        extension
                });
        });

/*
------------------------------------------------
EVENT:
Extension Uninstalled
------------------------------------------------
*/

chrome.management.onUninstalled
    .addListener(
        async function (extensionId) {
            console.log(
                "Extension Removed:",
                extensionId);

            await sendToArcon(
                {
                    event:
                        "UNINSTALLED",

                    timestamp:
                        new Date().toISOString(),

                    extensionId:
                        extensionId
                });
        });

/*
------------------------------------------------
Chrome Startup
------------------------------------------------
*/

chrome.runtime.onStartup
    .addListener(
        async function () {
            console.log(
                "Chrome Started");

            await scanExtensions();
        });

/*
------------------------------------------------
Send Violation to ARCON Backend
------------------------------------------------
*/
async function sendViolation(extension) {
    try {
        await sendToArcon(
            {
                action: "VIOLATION",
                extensionId: extension.id,
                extensionName: extension.name,
                timestamp: new Date().toISOString(),
                source: "INSTALL_EVENT"
            });
    }
    catch (error) {
        console.error("Violation messaging error", error);
    }
}


/*
------------------------------------------------
Extension Installed
------------------------------------------------
*/

chrome.runtime.onInstalled
    .addListener(
        async function () {
            console.log(
                "ARCON Extension Installed");

            await scanExtensions();
        });

/*
------------------------------------------------
Periodic Scan
Every 1 minute
------------------------------------------------
*/

chrome.alarms.create(
    "extensionScan",
    {
        periodInMinutes: 1
    });

chrome.alarms.onAlarm
    .addListener(
        async function (alarm) {
            if (
                alarm.name ===
                "extensionScan") {
                await scanExtensions();
            }
        });