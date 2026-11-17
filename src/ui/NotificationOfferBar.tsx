import { useEffect, useState } from 'react';
import { SERVER_GUI_PACKAGE_EVENT } from '../scripting/ScriptingEngine';
import { requestNotificationPermission, shouldOfferNotifications } from '../notificationPermission';
import { useAppStore } from '../storage/appStore';

/** The game's notification package (Tyme: tyme-notify) is present: offer desktop notifications with one click,
 *  the user gesture browsers require for the permission prompt. Never takes focus. */
export function NotificationOfferBar({ packageName = 'tyme-notify' }: { packageName?: string }) {
    const [open, setOpen] = useState(false);
    const patchClient = useAppStore(s => s.patchClient);
    useEffect(() => {
        const onPackage = (event: Event) => {
            if ((event as CustomEvent<string>).detail === packageName && shouldOfferNotifications()) setOpen(true);
        };
        window.addEventListener(SERVER_GUI_PACKAGE_EVENT, onPackage);
        return () => window.removeEventListener(SERVER_GUI_PACKAGE_EVENT, onPackage);
    }, [packageName]);
    if (!open) return null;
    return (
        <div className="notification-offer" role="region" aria-label="Desktop notifications">
            <span>Get desktop notifications for tells, mail and more? You can change this later in Settings &gt; General.</span>
            <button type="button" className="notification-offer-on" onClick={() => {
                setOpen(false);
                void requestNotificationPermission().then(result => patchClient({ notificationsEnabled: result === 'granted' ? true : undefined }));
            }}>Turn on</button>
            <button type="button" onClick={() => { setOpen(false); patchClient({ notificationOfferDismissed: true }); }}>No thanks</button>
        </div>
    );
}
