import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
const chrome=process.env.PLAYWRIGHT_CHROME_EXECUTABLE || (process.platform==='win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
export default defineConfig({
 testDir:'./e2e',fullyParallel:false,workers:1,timeout:60_000,expect:{timeout:15_000},
 reporter:[['list'],['html',{open:'never'}]],
 use:{baseURL:'http://127.0.0.1:5173',viewport:{width:1440,height:1000},trace:'retain-on-failure',screenshot:'only-on-failure',launchOptions:chrome?{executablePath:chrome}:{}},
 webServer:process.env.AEGIS_E2E_EXTERNAL==='1'?undefined:{command:'node scripts/e2e-stack.mjs',url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:120_000,gracefulShutdown:{signal:'SIGTERM',timeout:5000}},
});
