import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const appDelegatePath = path.join(root, 'ios', 'App', 'App', 'AppDelegate.swift')
const infoPlistPath = path.join(root, 'ios', 'App', 'App', 'Info.plist')

if (!fs.existsSync(appDelegatePath) || !fs.existsSync(infoPlistPath)) {
  console.log('[ios] Native iOS project not found yet. Run npm run ios:add first.')
  process.exit(0)
}

let appDelegate = fs.readFileSync(appDelegatePath, 'utf8')
if (!appDelegate.includes('import AVFoundation')) {
  appDelegate = appDelegate.replace('import UIKit\n', 'import UIKit\nimport AVFoundation\n')
}

if (!appDelegate.includes('var audioSessionRefreshTimer: Timer?')) {
  appDelegate = appDelegate.replace('    var window: UIWindow?\n', '    var window: UIWindow?\n    var audioSessionRefreshTimer: Timer?\n')
}

const helper = `
    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers])
            try session.setActive(true, options: [])
        } catch {
            print("Failed to configure audio session: \\(error)")
        }
    }
`

if (appDelegate.includes('AVAudioSession.sharedInstance()') && !appDelegate.includes('private func configureAudioSession()')) {
  const start = appDelegate.indexOf('        do {\n            let session = AVAudioSession.sharedInstance()')
  if (start !== -1) {
    const endMarker = '        }\n\n        return true'
    const end = appDelegate.indexOf(endMarker, start)
    if (end !== -1) {
      appDelegate = `${appDelegate.slice(0, start)}        configureAudioSession()\n${appDelegate.slice(end + '        }\n'.length)}`
    }
  }
}

if (!appDelegate.includes('configureAudioSession()')) {
  appDelegate = appDelegate.replace('        return true\n    }', '        configureAudioSession()\n\n        return true\n    }')
}

if (!appDelegate.includes('DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {\n            self.configureAudioSession()\n        }\n\n        return true')) {
  appDelegate = appDelegate.replace(
    '        configureAudioSession()\n\n        return true',
    '        configureAudioSession()\n        startAudioSessionRefreshTimer()\n        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {\n            self.configureAudioSession()\n        }\n\n        return true'
  )
}

if (!appDelegate.includes('private func configureAudioSession()')) {
  const lastBrace = appDelegate.lastIndexOf('\n}')
  appDelegate = `${appDelegate.slice(0, lastBrace)}\n${helper}${appDelegate.slice(lastBrace)}`
}

if (!appDelegate.includes('func applicationDidBecomeActive(_ application: UIApplication) {\n        configureAudioSession()')) {
  appDelegate = appDelegate.replace(
    'func applicationDidBecomeActive(_ application: UIApplication) {',
    'func applicationDidBecomeActive(_ application: UIApplication) {\n        configureAudioSession()'
  )
}

if (!appDelegate.includes('func applicationDidBecomeActive(_ application: UIApplication) {\n        configureAudioSession()\n        startAudioSessionRefreshTimer()\n        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5)')) {
  appDelegate = appDelegate.replace(
    'func applicationDidBecomeActive(_ application: UIApplication) {\n        configureAudioSession()',
    'func applicationDidBecomeActive(_ application: UIApplication) {\n        configureAudioSession()\n        startAudioSessionRefreshTimer()\n        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {\n            self.configureAudioSession()\n        }'
  )
}

appDelegate = appDelegate.replace(
  'try session.setCategory(.playback, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])',
  'try session.setCategory(.playback, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers])'
)

if (!appDelegate.includes('applicationWillResignActive(_ application: UIApplication) {\n        audioSessionRefreshTimer?.invalidate()')) {
  appDelegate = appDelegate.replace(
    'func applicationWillResignActive(_ application: UIApplication) {',
    'func applicationWillResignActive(_ application: UIApplication) {\n        audioSessionRefreshTimer?.invalidate()\n        audioSessionRefreshTimer = nil'
  )
}

if (!appDelegate.includes('private func startAudioSessionRefreshTimer()')) {
  appDelegate = appDelegate.replace(
    '\n}\n',
    '\n    private func startAudioSessionRefreshTimer() {\n        audioSessionRefreshTimer?.invalidate()\n        audioSessionRefreshTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in\n            self?.configureAudioSession()\n        }\n        if let timer = audioSessionRefreshTimer {\n            RunLoop.main.add(timer, forMode: .common)\n        }\n    }\n\n}\n'
  )
}

fs.writeFileSync(appDelegatePath, appDelegate)

let infoPlist = fs.readFileSync(infoPlistPath, 'utf8')
if (!infoPlist.includes('<string>audio</string>')) {
  infoPlist = infoPlist.replace('</dict>', '\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>')
}
if (!infoPlist.includes('<key>UIFileSharingEnabled</key>')) {
  infoPlist = infoPlist.replace('</dict>', '\t<key>UIFileSharingEnabled</key>\n\t<true/>\n\t<key>LSSupportsOpeningDocumentsInPlace</key>\n\t<true/>\n</dict>')
}
fs.writeFileSync(infoPlistPath, infoPlist)
console.log('[ios] Configured AVAudioSession playback category, Bluetooth routes, audio background mode, and Files app sharing.')
