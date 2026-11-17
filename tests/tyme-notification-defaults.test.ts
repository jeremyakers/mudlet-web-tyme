import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from '../src/storage/appStore';
import { requestNotificationPermission, shouldOfferNotifications } from '../src/notificationPermission';

// Desktop notifications are on unless the player turns them off. The permission prompt comes only from the
// offer bar's "Turn on" click (shown when the game's notification package is present), never from typing.
describe('desktop notification defaults and offer', () => {
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
        useAppStore.setState(s => ({ client: { ...s.client, notificationsEnabled: undefined, notificationOfferDismissed: undefined } }));
    });
    afterEach(() => { (window as unknown as { Notification?: unknown }).Notification = original; });

    it('never asks on a key press or click by itself', () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        window.dispatchEvent(new MouseEvent('click'));
        expect(requests).toBe(0);
    });

    it('offers only while the browser has not decided and the player has not declined', () => {
        expect(shouldOfferNotifications()).toBe(true);
        useAppStore.setState(s => ({ client: { ...s.client, notificationOfferDismissed: true } }));
        expect(shouldOfferNotifications()).toBe(false);
        useAppStore.setState(s => ({ client: { ...s.client, notificationOfferDismissed: undefined, notificationsEnabled: false } }));
        expect(shouldOfferNotifications()).toBe(false);
        useAppStore.setState(s => ({ client: { ...s.client, notificationsEnabled: undefined } }));
        permission = 'granted';
        expect(shouldOfferNotifications()).toBe(false);
    });

    it('a Turn on request asks once and announces the answer for Settings', async () => {
        const seen: string[] = [];
        window.addEventListener('tyme-notification-permission', e => seen.push((e as CustomEvent).detail));
        await requestNotificationPermission();
        expect([requests, seen]).toEqual([1, ['granted']]);
    });

    it('treats an unset setting as on, and the bar is shown in the session and wired to the package event', () => {
        const profile = readFileSync('src/ProfileSession.tsx', 'utf8');
        expect(profile).toMatch(/'notifyOnNewData'\)\) !== false/);
        expect(profile).toMatch(/<NotificationOfferBar \/>/);
        expect(readFileSync('src/scripting/ScriptingAPI.ts', 'utf8')).toMatch(/client\.notificationsEnabled !== false/);
        expect(readFileSync('src/scripting/ScriptingEngine.ts', 'utf8')).toMatch(/announceServerGuiPackage\(existing!\.name\)[\s\S]*announceServerGuiPackage\(finalManifest\.name\)/);
    });
});
