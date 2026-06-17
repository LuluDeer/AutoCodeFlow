import AutoLaunch from 'auto-launch';
import { app } from 'electron';
import log from './logger';

const autoLauncher = new AutoLaunch({
  name: 'AutoCodeFlow Executor',
  path: app.getPath('exe'),
});

export async function getAutoLaunchEnabled(): Promise<boolean> {
  try {
    return await autoLauncher.isEnabled();
  } catch (err: any) {
    log.warn(`autolaunch.isEnabled failed: ${err.message}`);
    return false;
  }
}

export async function setAutoLaunchEnabled(enable: boolean): Promise<void> {
  try {
    if (enable) {
      await autoLauncher.enable();
      log.info('Auto-launch enabled');
    } else {
      await autoLauncher.disable();
      log.info('Auto-launch disabled');
    }
  } catch (err: any) {
    log.warn(`autolaunch.set(${enable}) failed: ${err.message}`);
  }
}
