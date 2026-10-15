import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const androidDir = join(projectRoot, 'android');
const employeeOnly = process.argv.includes('--employee');
if (employeeOnly) {
  const assets = join(androidDir, 'app', 'src', 'main', 'assets');
  const config = JSON.parse(readFileSync(join(assets, 'capacitor.config.json'), 'utf8'));
  const audit = JSON.parse(readFileSync(join(assets, 'public', 'employee-build.json'), 'utf8'));
  if (config.webDir !== 'dist-employee' || audit.target !== 'employee') {
    throw new Error('Run npm run android:sync:employee before packaging the employee APK.');
  }
}
const localJdk = join(projectRoot, '.toolchains', 'jdk-21');
const localSdk = join(projectRoot, '.toolchains', 'android-sdk');
const javaHome = existsSync(join(localJdk, 'bin', 'java')) ? localJdk : process.env.JAVA_HOME;
const androidHome = existsSync(join(localSdk, 'platforms')) ? localSdk : process.env.ANDROID_HOME;

if (!javaHome || !androidHome) {
  console.error('Missing Android toolchain. Install JDK 21 and Android SDK, or restore .toolchains/.');
  process.exit(1);
}

const result = spawnSync(join(androidDir, 'gradlew'), [
  '-p', androidDir,
  'testDebugUnitTest',
  ':app:assembleDebugAndroidTest',
  'assembleDebug',
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
    ANDROID_USER_HOME: join(projectRoot, '.toolchains', 'android-user-home'),
    GRADLE_USER_HOME: join(projectRoot, '.toolchains', 'gradle-home'),
    GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ''} -Duser.language=en -Duser.country=US`.trim(),
  },
  stdio: 'inherit',
});

if (result.status !== 0) process.exit(result.status ?? 1);

const source = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const outputDir = join(projectRoot, 'outputs', 'android');
const destination = join(outputDir, employeeOnly ? 'ice-delivery-employee-1.0.3.apk' : 'ice-delivery-debug.apk');
mkdirSync(outputDir, { recursive: true });
copyFileSync(source, destination);
console.log(`APK: ${destination}`);
