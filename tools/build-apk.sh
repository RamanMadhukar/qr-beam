#!/bin/sh
# Builds a debug APK at android/app/build/outputs/apk/debug/app-debug.apk.
# Uses JAVA_HOME / ANDROID_HOME when set, otherwise looks for Homebrew's JDK 21 and
# Android command-line tools, then Android Studio's bundled JDK and SDK.
# Run with: npm run apk
set -e
cd "$(dirname "$0")/.."

if [ -z "$JAVA_HOME" ]; then
  for candidate in \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -x "$candidate/bin/java" ]; then export JAVA_HOME="$candidate"; break; fi
  done
fi

if [ -z "$ANDROID_HOME" ]; then
  for candidate in /opt/homebrew/share/android-commandlinetools "$HOME/Library/Android/sdk"; do
    if [ -d "$candidate/platforms" ]; then export ANDROID_HOME="$candidate"; break; fi
  done
fi

if [ -z "$JAVA_HOME" ] || [ -z "$ANDROID_HOME" ]; then
  echo "Need JDK 21 and the Android SDK. Install Android Studio, or see README.md > Building the apps." >&2
  exit 1
fi

npx cap sync android
cd android
./gradlew assembleDebug
echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
