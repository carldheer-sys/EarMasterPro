import { useEffect, useState } from 'react'
import { CheckCircle, XCircle, Info } from 'lucide-react'

export function Toast({ message, type = 'success', duration = 3000, onClose }) {
  const [isVisible, setIsVisible] = useState(true)
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    const exitTimer = setTimeout(() => {
      setIsExiting(true)
    }, duration - 300)

    const closeTimer = setTimeout(() => {
      setIsVisible(false)
      if (onClose) onClose()
    }, duration)

    return () => {
      clearTimeout(exitTimer)
      clearTimeout(closeTimer)
    }
  }, [duration, onClose])

  if (!isVisible) return null

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-green-500" />,
    error: <XCircle className="w-5 h-5 text-red-500" />,
    info: <Info className="w-5 h-5 text-blue-500" />
  }

  const bgColors = {
    success: 'bg-green-50 border-green-200',
    error: 'bg-red-50 border-red-200',
    info: 'bg-blue-50 border-blue-200'
  }

  return (
    <div
      onClick={() => {
        setIsVisible(false)
        if (onClose) onClose()
      }}
      className={`fixed top-4 right-4 z-[9999] flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg transition-all duration-300 cursor-pointer hover:opacity-80 ${
        bgColors[type]
      } ${isExiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'}`}
      style={{ minWidth: '300px', maxWidth: '500px' }}
    >
      {icons[type]}
      <span className="text-sm font-medium text-gray-900">{message}</span>
    </div>
  )
}

export function ToastContainer({ toasts, removeToast }) {
  return (
    <div className="fixed top-0 right-0 z-[9999] pointer-events-none">
      {toasts.map((toast, index) => (
        <div
          key={toast.id}
          style={{ marginTop: `${index * 70}px` }}
          className="pointer-events-auto"
        >
          <Toast
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            onClose={() => removeToast(toast.id)}
          />
        </div>
      ))}
    </div>
  )
}
