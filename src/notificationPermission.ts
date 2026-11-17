import { useAppStore } from './storage/appStore';

/**
 * Desktop notifications are on by default, but a browser only asks for
 * permission after a user gesture. Ask once, on the player's first click or key
 * press in the client, unless they turned notifications off in Settings or the
 * browser has already decided.
 */
export function installFirstGestureNotificationPermission(): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const ask = () => {
        window.removeEventListener('pointerdown', ask, true);
        window.removeEventListener('keydown', ask, true);
        if (Notification.permission !== 'default') return;
        if (useAppStore.getState().client.notificationsEnabled === false) return;
        void Notification.requestPermission().catch(() => { /* left at default */ });
    };
    window.addEventListener('pointerdown', ask, true);
    window.addEventListener('keydown', ask, true);
}
