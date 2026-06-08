import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const buildDir = path.join(root, 'build', 'ios-ipa')
const derivedData = path.join(buildDir, 'DerivedData')
const appPath = path.join(derivedData, 'Build', 'Products', 'Release-iphoneos', 'App.app')
const payloadDir = path.join(buildDir, 'Payload')
const ipaPath = path.join(buildDir, 'EarMasterPro.ipa')
const iconBuildDir = path.join(root, 'build', 'icon')
const iconSvg = path.join(root, 'public', 'icons', 'icon-512.svg')
const renderedIcon = path.join(iconBuildDir, 'icon-512.svg.png')
const iosIcon = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png')

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', cwd: options.cwd || root })
}

fs.rmSync(buildDir, { recursive: true, force: true })
run('npm', ['run', 'ios:sync'])
fs.rmSync(iconBuildDir, { recursive: true, force: true })
fs.mkdirSync(iconBuildDir, { recursive: true })
run('qlmanage', ['-t', '-s', '1024', '-o', iconBuildDir, iconSvg])
if (fs.existsSync(renderedIcon)) fs.copyFileSync(renderedIcon, iosIcon)
run('xcodebuild', [
  '-workspace', 'ios/App/App.xcworkspace',
  '-scheme', 'App',
  '-configuration', 'Release',
  '-sdk', 'iphoneos',
  '-destination', 'generic/platform=iOS',
  '-allowIneligibleDestinations',
  '-derivedDataPath', derivedData,
  'CODE_SIGNING_ALLOWED=NO',
  'CODE_SIGNING_REQUIRED=NO',
  'CODE_SIGN_IDENTITY=',
  'build'
])

if (!fs.existsSync(appPath)) {
  throw new Error(`Expected app was not built at ${appPath}`)
}

fs.mkdirSync(payloadDir, { recursive: true })
fs.cpSync(appPath, path.join(payloadDir, 'App.app'), { recursive: true })
try { fs.rmSync(ipaPath, { force: true }) } catch {}
run('/usr/bin/zip', ['-qry', 'EarMasterPro.ipa', 'Payload'], { cwd: buildDir })
console.log(`\nCreated ${ipaPath}`)
