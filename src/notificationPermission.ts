import { useAppStore } from './storage/appStore';

/** Fired on window with the new NotificationPermission after a request resolves. */
export const NOTIFICATION_PERMISSION_EVENT = 'tyme-notification-permission';

/**
 * Desktop notifications are on by default, but a browser only asks for
 * permission from a completed user activation. Ask once, on the player's first
 * click or key press in the client (click also completes a touch), unless they
 * turned notifications off in Settings or the browser has already decided.
 */
export function installFirstGestureNotificationPermission(): void {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const stop = () => {
        window.removeEventListener('click', ask, true);
        window.removeEventListener('keydown', ask, true);
    };
    function ask() {
        if (Notification.permission !== 'default' || useAppStore.getState().client.notificationsEnabled === false) {
            stop();
            return;
        }
        stop();
        void Notification.requestPermission()
            .then(result => window.dispatchEvent(new CustomEvent(NOTIFICATION_PERMISSION_EVENT, { detail: result })))
            .catch(() => { /* left at default */ });
    }
    window.addEventListener('click', ask, true);
    window.addEventListener('keydown', ask, true);
}
