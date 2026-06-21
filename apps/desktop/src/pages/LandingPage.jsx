import { useNavigate } from 'react-router-dom'
import { Music, Edit3, Headphones, Lock, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { motion } from 'framer-motion'
import { useTheme } from '@/hooks/useTheme'

function LandingPage() {
  const navigate = useNavigate()
  const { isDark, toggleTheme } = useTheme()

  const features = [
    {
      id: 'transcription',
      title: 'Transcription',
      subtitle: 'Coming Soon!',
      icon: Music,
      locked: true,
      path: null,
    },
    {
      id: 'midi-editor',
      title: 'MIDI Editor',
      subtitle: 'Refine your MIDI track in this editor.',
      icon: Edit3,
      locked: false,
      path: '/midi-editor',
    },
    {
      id: 'ear-training',
      title: 'Ear Training',
      subtitle: 'Learn to transcribe by ear!',
      icon: Headphones,
      locked: false,
      path: '/ear-trainer',
    },
  ]

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-4xl font-bold mb-12">Ear Master Pro</h1>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto mt-20">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={feature.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
              >
                <button
                  onClick={() => !feature.locked && navigate(feature.path)}
                  disabled={feature.locked}
                  className={`
                    relative w-full h-64 rounded-lg border-2 transition-all duration-300
                    ${
                      feature.locked
                        ? 'border-muted bg-muted/20 cursor-not-allowed opacity-50'
                        : 'border-primary bg-card hover:bg-accent hover:border-accent-foreground cursor-pointer hover:scale-105'
                    }
                    flex flex-col items-center justify-center p-8 group
                  `}
                >
                  {feature.locked && (
                    <div className="absolute top-4 right-4">
                      <Lock className="w-6 h-6 text-muted-foreground" />
                    </div>
                  )}
                  
                  <div className={`
                    mb-6 p-6 rounded-full transition-colors
                    ${
                      feature.locked
                        ? 'bg-muted/30'
                        : 'bg-primary/10 group-hover:bg-primary/20'
                    }
                  `}>
                    <Icon className={`
                      w-12 h-12
                      ${feature.locked ? 'text-muted-foreground' : 'text-primary'}
                    `} />
                  </div>

                  <h2 className={`
                    text-2xl font-bold mb-2
                    ${feature.locked ? 'text-muted-foreground' : 'text-foreground'}
                  `}>
                    {feature.title}
                  </h2>
                  
                  <p className={`
                    text-sm text-center
                    ${feature.locked ? 'text-muted-foreground' : 'text-muted-foreground'}
                  `}>
                    {feature.subtitle}
                  </p>
                </button>
              </motion.div>
            )
          })}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="text-center mt-16 text-muted-foreground"
        >
          <p className="text-sm">
            Select a feature above to get started
          </p>
        </motion.div>
      </div>

      <div className="fixed bottom-4 right-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          className="h-9 w-9 rounded-full border border-border bg-card"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
        </Button>
      </div>
    </div>
  )
}

export default LandingPage
