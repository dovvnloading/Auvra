
import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type NotificationType = 'info' | 'success' | 'error' | 'loading';

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
  duration?: number; // ms. If 'loading', no default timeout.
  progress?: number; // 0-100. If present, renders a determinate progress bar.
}

interface NotificationContextType {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id'> & { id?: string }) => string;
  updateNotification: (id: string, updates: Partial<Omit<Notification, 'id'>>) => void;
  removeNotification: (id: string) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

export const useNotification = () => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotification must be used within a NotificationProvider');
  }
  return context;
};

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const removeNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const updateNotification = useCallback((id: string, updates: Partial<Omit<Notification, 'id'>>) => {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, ...updates } : n));
  }, []);

  const addNotification = useCallback((notif: Omit<Notification, 'id'> & { id?: string }) => {
    // Generate ID with fallback for non-secure contexts where crypto.randomUUID is unavailable
    let id = notif.id;
    if (!id) {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            id = crypto.randomUUID();
        } else {
            // Simple fallback for unique ID
            id = Date.now().toString(36) + Math.random().toString(36).substring(2);
        }
    }
    
    const newNotification: Notification = { ...notif, id: id! };

    setNotifications(prev => [...prev, newNotification]);

    // Auto-dismiss logic for non-loading types
    if (notif.type !== 'loading') {
        const duration = notif.duration || 4000;
        setTimeout(() => {
            removeNotification(id!);
        }, duration);
    }

    return id!;
  }, [removeNotification]);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, updateNotification, removeNotification }}>
      {children}
    </NotificationContext.Provider>
  );
};
