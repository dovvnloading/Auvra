
import React from 'react';
import { X, Check, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useNotification, Notification, NotificationType } from '../../context/NotificationContext';

const NOTIFICATION_COLORS: Record<NotificationType, string> = {
    info: 'bg-blue-600',
    success: 'bg-green-600',
    error: 'bg-red-600',
    loading: 'bg-blue-500'
};

const NOTIFICATION_ICONS: Record<NotificationType, React.ReactNode> = {
    info: <Info size={16} className="text-gray-300" />,
    success: <Check size={16} className="text-gray-300" />,
    error: <AlertTriangle size={16} className="text-gray-300" />,
    loading: <Loader2 size={16} className="text-blue-400 animate-spin" />
};

const UEToast: React.FC<{ notification: Notification; onDismiss: (id: string) => void }> = ({ notification, onDismiss }) => {
    return (
        <div className="relative group w-80 animate-in slide-in-from-right-10 fade-in duration-300">
            {/* Main Card */}
            <div className="flex bg-[#1b1b1b] border border-[#050505] shadow-xl overflow-hidden min-h-[50px]">
                
                {/* Status Strip (Left) */}
                <div className={`w-1 shrink-0 ${NOTIFICATION_COLORS[notification.type]}`} />
                
                {/* Content */}
                <div className="flex-1 p-3 flex flex-col justify-center min-w-0">
                    <div className="flex items-start gap-3">
                        <div className="mt-0.5 shrink-0">
                            {NOTIFICATION_ICONS[notification.type]}
                        </div>
                        <div className="flex-1 min-w-0">
                            {/* Title / Type Label (UE Style) */}
                            <div className="text-[10px] uppercase font-bold text-gray-500 tracking-wider mb-0.5">
                                {notification.type}
                            </div>
                            {/* Message */}
                            <div className="text-xs text-gray-200 font-medium leading-relaxed break-words">
                                {notification.message}
                            </div>
                        </div>
                    </div>

                    {/* Loading Progress Bar */}
                    {notification.type === 'loading' && (
                        <div className="mt-3 h-0.5 w-full bg-gray-800 rounded-full overflow-hidden">
                            {typeof notification.progress === 'number' ? (
                                <div 
                                    className="h-full bg-blue-500 transition-all duration-300 ease-out"
                                    style={{ width: `${Math.max(0, Math.min(100, notification.progress))}%` }}
                                />
                            ) : (
                                <div className="h-full bg-blue-500 animate-progress-indeterminate"></div>
                            )}
                        </div>
                    )}
                </div>

                {/* Dismiss Button */}
                <button 
                    onClick={() => onDismiss(notification.id)}
                    className="w-8 shrink-0 flex items-start justify-center pt-2 text-gray-600 hover:text-white transition-colors"
                >
                    <X size={14} />
                </button>
            </div>
        </div>
    );
};

export const NotificationContainer: React.FC = () => {
    const { notifications, removeNotification } = useNotification();

    return (
        <div className="fixed bottom-0 right-0 z-[100] p-6 flex flex-col gap-2 pointer-events-none items-end max-h-screen overflow-hidden">
            <div className="flex flex-col gap-2 pointer-events-auto items-end">
                {notifications.map(n => (
                    <UEToast key={n.id} notification={n} onDismiss={removeNotification} />
                ))}
            </div>
            
            {/* Tailwind Custom Animation Injection for the Progress Bar */}
            <style>{`
                @keyframes progress-indeterminate {
                    0% { width: 0%; margin-left: 0%; }
                    50% { width: 50%; margin-left: 25%; }
                    100% { width: 0%; margin-left: 100%; }
                }
                .animate-progress-indeterminate {
                    animation: progress-indeterminate 1.5s ease-in-out infinite;
                }
            `}</style>
        </div>
    );
};
