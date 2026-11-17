import { useAppStore } from './storage/appStore';

/** Fired on window with the new NotificationPermission after a request resolves. */
export const NOTIFICATION_PERMISSION_EVENT = 'tyme-notification-permission';

/** Ask the browser for notification permission (call from a click) and announce the answer. */
export function requestNotificationPermission(): Promise<NotificationPermission> {
    if (typeof window === 'undefined' || !('Notification' in window)) return Promise.resolve('denied');
    return Notification.requestPermission().then(result => {
        window.dispatchEvent(new CustomEvent(NOTIFICATION_PERMISSION_EVENT, { detail: result }));
        return result;
    });
}

/** Whether to offer the "Turn on desktop notifications" bar: the browser has not decided yet, and the
 *  player neither turned notifications off nor dismissed the offer. */
export function shouldOfferNotifications(): boolean {
    if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'default') return false;
    const client = useAppStore.getState().client;
    return client.notificationsEnabled !== false && client.notificationOfferDismissed !== true;
}
