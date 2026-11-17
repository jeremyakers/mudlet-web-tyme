import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/storage/appStore';
import { installFirstGestureNotificationPermission } from '../src/notificationPermission';

// Desktop notifications are on unless the player turns them off: the browser is asked
// for permission on the first click or key press, never before a user gesture.
describe('desktop notification defaults', () => {
    const original = (window as unknown as { Notification?: unknown }).Notification;
    let permission: NotificationPermission;
    let requests: number;
    beforeEach(() => {
        permission = 'default';
        requests = 0;
        const Fake = function () { /* a notification */ } as unknown as { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> };
        Object.defineProperty(Fake, 'permission', { get: () => permission });
        Fake.requestPermission = () => { requests++; permission = 'granted'; return Promise.resolve(permission); };
        (window as unknown as { Notification: unknown }).Notification = Fake;
        useAppStore.setState(s => ({ client: { ...s.client, notificationsEnabled: undefined } }));
    });
    afterEach(() => { (window as unknown as { Notification?: unknown }).Notification = original; });

    it('asks on a click (which completes a touch), not on pointerdown', () => {
        installFirstGestureNotificationPermission();
        window.dispatchEvent(new Event('pointerdown'));
        expect(requests).toBe(0);
        window.dispatchEvent(new MouseEvent('click'));
        expect(requests).toBe(1);
    });

    it('announces the resolved permission so an open Settings panel can update', async () => {
        const seen: string[] = [];
        window.addEventListener('tyme-notification-permission', e => seen.push((e as CustomEvent).detail));
        installFirstGestureNotificationPermission();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        await Promise.resolve(); await Promise.resolve();
        expect(seen).toEqual(['granted']);
    });

    it('asks for permission once, on the first key press, when the player has not turned them off', () => {
        installFirstGestureNotificationPermission();
        expect(requests).toBe(0);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
        expect(requests).toBe(1);
    });

    it('does not ask when the player turned notifications off', () => {
        useAppStore.setState(s => ({ client: { ...s.client, notificationsEnabled: false } }));
        installFirstGestureNotificationPermission();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        expect(requests).toBe(0);
    });

    it('treats an unset setting as on for notify-on-new-data and desktop notifications', async () => {
        const source = await import('node:fs').then(fs => ({
            profile: fs.readFileSync('src/ProfileSession.tsx', 'utf8'),
            api: fs.readFileSync('src/scripting/ScriptingAPI.ts', 'utf8'),
        }));
        expect(source.profile).toMatch(/'notifyOnNewData'\)\) !== false/);
        expect(source.api).toMatch(/client\.notificationsEnabled !== false/);
    });
});
