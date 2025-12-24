import * as THREE from 'three';

export class SoundManager {
    constructor(camera) {
        // Create audio listener and attach to camera
        this.listener = new THREE.AudioListener();
        camera.add(this.listener);

        // Audio loader
        this.audioLoader = new THREE.AudioLoader();

        // Sound objects
        this.sounds = {};
        this.isLoaded = false;
        this.contextResumed = false;

        // Cup tap sprite definitions - will be auto-detected from audio
        this.cupTapSprites = [];

        // Cough sprite definitions - will be auto-detected from audio
        this.coughSprites = [];

        // Setup audio context resume on first user interaction
        this.setupContextResume();
    }

    /**
     * Setup listeners to resume audio context on first user interaction
     * Required due to browser autoplay policies
     */
    setupContextResume() {
        const resumeContext = async () => {
            if (this.contextResumed) return;

            const context = this.listener.context;
            if (context.state === 'suspended') {
                try {
                    await context.resume();
                    console.log('Audio context resumed');
                    this.contextResumed = true;

                    // Start ambient sound now that context is resumed
                    if (this.isLoaded) {
                        this.startAmbient();
                    }
                } catch (e) {
                    console.warn('Failed to resume audio context:', e);
                }
            } else {
                this.contextResumed = true;
            }
        };

        // Listen for various user interactions
        ['click', 'touchstart', 'keydown', 'mousedown'].forEach(event => {
            document.addEventListener(event, resumeContext, { once: true });
        });
    }

    /**
     * Analyze audio buffer to detect volume peaks (transients) with dynamic durations
     * Returns array of { start, duration } for each detected sound
     */
    detectPeaks(buffer, options = {}) {
        const {
            threshold = 0.15,        // Volume threshold (0-1) to trigger detection
            endThreshold = 0.05,     // Volume threshold to detect end of sound
            minGap = 0.2,           // Minimum seconds between peaks
            minDuration = 0.2,      // Minimum duration of each sprite
            maxDuration = 2.0,      // Maximum duration of each sprite
            windowSize = 1024       // Samples per analysis window
        } = options;

        const channelData = buffer.getChannelData(0); // Use first channel
        const sampleRate = buffer.sampleRate;
        const sprites = [];

        let lastPeakTime = -minGap;
        let inSound = false;
        let soundStart = 0;

        // Scan through audio in windows
        for (let i = 0; i < channelData.length; i += windowSize) {
            // Calculate RMS (root mean square) volume for this window
            let sum = 0;
            const windowEnd = Math.min(i + windowSize, channelData.length);
            for (let j = i; j < windowEnd; j++) {
                sum += channelData[j] * channelData[j];
            }
            const rms = Math.sqrt(sum / (windowEnd - i));

            const currentTime = i / sampleRate;

            if (!inSound) {
                // Check if this is a new peak above threshold with enough gap from last
                if (rms > threshold && (currentTime - lastPeakTime) >= minGap) {
                    inSound = true;
                    soundStart = currentTime;
                }
            } else {
                // We're in a sound - check if it ended (volume dropped below end threshold)
                // or if we've hit max duration
                const elapsed = currentTime - soundStart;
                if (rms < endThreshold || elapsed >= maxDuration) {
                    // Sound ended - calculate dynamic duration
                    const duration = Math.max(minDuration, elapsed);
                    sprites.push({
                        start: soundStart,
                        duration: duration
                    });
                    lastPeakTime = soundStart;
                    inSound = false;
                }
            }
        }

        // Handle case where sound extends to end of buffer
        if (inSound) {
            const finalTime = channelData.length / sampleRate;
            const duration = Math.max(minDuration, finalTime - soundStart);
            sprites.push({
                start: soundStart,
                duration: Math.min(duration, maxDuration)
            });
        }

        console.log(`Detected ${sprites.length} peaks in audio:`, sprites);
        return sprites;
    }

    async init() {
        try {
            // Load all sounds
            await Promise.all([
                this.loadSound('sip', 'sounds/440063__macithappen__coffee-sip.wav', {
                    volume: 0.7,
                    offset: 3.0,      // Start at 3 seconds
                    duration: 3.5    // Play for 3.5 seconds (till 6.5s)
                }),
                this.loadSound('smoke', 'sounds/218082__gaby7129__cigarette-cracklings-lighter-smoke.wav', {
                    volume: 0.6,
                    offset: 1.0,     // Start at 1 second
                    loop: true       // Loop while held
                }),
                this.loadSound('cupTap', 'sounds/413635__krnfa__foley-cup-on-the-table.wav', { volume: 0.5 }),
                this.loadSound('ambient', 'sounds/482990__priesjensen__people-talking-at-cafe-ambience.wav', {
                    volume: 2.0,
                    loop: true
                }),
                this.loadSound('ambient2', 'sounds/661805__klankbeeld__village-street-traffic-1158-220820_0507.wav', {
                    volume: 1.5,
                    loop: true
                }),
                this.loadSound('break', 'sounds/735851__geoff-bremner-audio__smashing-breaking-porcelain-mug-2.wav', {
                    volume: 0.8
                }),
                this.loadSound('cough', 'sounds/722622__midwestdocumentary__coughs-gentle-processing.wav', {
                    volume: 0.8
                }),
            ]);

            // Auto-detect cup tap sprites from audio peaks (with dynamic durations)
            const cupTapData = this.sounds['cupTap'];
            if (cupTapData && cupTapData.buffer) {
                this.cupTapSprites = this.detectPeaks(cupTapData.buffer, {
                    threshold: 0.1,      // Volume to trigger detection
                    endThreshold: 0.03,  // Volume to detect end of tap
                    minGap: 0.3,         // Min 300ms between taps
                    minDuration: 0.2,    // Each tap at least 200ms
                    maxDuration: 0.8     // Each tap at most 800ms
                });
            }

            // Auto-detect cough sprites from audio peaks (with dynamic durations)
            const coughData = this.sounds['cough'];
            if (coughData && coughData.buffer) {
                this.coughSprites = this.detectPeaks(coughData.buffer, {
                    threshold: 0.12,     // Higher threshold to catch start of cough
                    endThreshold: 0.04,  // Higher end threshold to not cut off early
                    minGap: 1.5,         // Min 1.5s between coughs (they're distinct)
                    minDuration: 1.0,    // Each cough at least 1 second
                    maxDuration: 2.5     // Each cough at most 2.5s
                });
                console.log(`Detected ${this.coughSprites.length} cough sprites`);
            }

            this.isLoaded = true;
            console.log('All sounds loaded');

            // Start ambient if audio context is already resumed
            if (this.contextResumed) {
                this.startAmbient();
            }
        } catch (e) {
            console.warn('Failed to load some sounds:', e);
        }
    }

    loadSound(name, url, options = {}) {
        return new Promise((resolve, reject) => {
            this.audioLoader.load(
                url,
                (buffer) => {
                    const sound = new THREE.Audio(this.listener);
                    sound.setBuffer(buffer);
                    sound.setVolume(options.volume || 1.0);
                    sound.setLoop(options.loop || false);

                    this.sounds[name] = {
                        sound: sound,
                        buffer: buffer,
                        options: options
                    };

                    console.log(`Sound loaded: ${name}`);
                    resolve(sound);
                },
                undefined,
                (err) => {
                    console.warn(`Failed to load sound: ${name}`, err);
                    resolve(null); // Don't reject, just continue without this sound
                }
            );
        });
    }

    play(name) {
        const soundData = this.sounds[name];
        if (!soundData) return;

        const { sound, options } = soundData;

        // Stop if already playing (for non-looping sounds)
        if (sound.isPlaying && !options.loop) {
            sound.stop();
        }

        if (!sound.isPlaying) {
            // Apply offset and duration if specified
            if (options.offset !== undefined) {
                sound.offset = options.offset;
            }
            if (options.duration !== undefined) {
                sound.duration = options.duration;
            }
            sound.play();
        }
    }

    stop(name) {
        const soundData = this.sounds[name];
        if (soundData && soundData.sound.isPlaying) {
            soundData.sound.stop();
        }
    }

    // Play a random segment from the cup tap audio file
    playCupTap() {
        const soundData = this.sounds['cupTap'];
        if (!soundData) return;

        // Fallback if no sprites detected
        if (this.cupTapSprites.length === 0) {
            console.warn('No cup tap sprites detected, playing from start');
            const sound = new THREE.Audio(this.listener);
            sound.setBuffer(soundData.buffer);
            sound.setVolume(soundData.options.volume || 0.5);
            sound.duration = 0.5;
            sound.play();
            return;
        }

        // Pick a random sprite
        const sprite = this.cupTapSprites[Math.floor(Math.random() * this.cupTapSprites.length)];

        // Create a new Audio instance for overlapping plays
        const sound = new THREE.Audio(this.listener);
        sound.setBuffer(soundData.buffer);
        sound.setVolume(soundData.options.volume || 0.5);

        // Set the playback range
        sound.offset = sprite.start;
        sound.duration = sprite.duration;

        sound.play();
    }

    // Play a random cough from the cough audio file
    playCough() {
        const soundData = this.sounds['cough'];
        if (!soundData) return;

        // Fallback if no sprites detected
        if (this.coughSprites.length === 0) {
            console.warn('No cough sprites detected, playing from start');
            const sound = new THREE.Audio(this.listener);
            sound.setBuffer(soundData.buffer);
            sound.setVolume(soundData.options.volume || 0.8);
            sound.duration = 0.8;
            sound.play();
            return;
        }

        // Pick a random sprite
        const sprite = this.coughSprites[Math.floor(Math.random() * this.coughSprites.length)];

        // Create a new Audio instance for overlapping plays
        const sound = new THREE.Audio(this.listener);
        sound.setBuffer(soundData.buffer);
        sound.setVolume(soundData.options.volume || 0.8);

        // Set the playback range
        sound.offset = sprite.start;
        sound.duration = sprite.duration;

        sound.play();
    }

    playSip() {
        this.play('sip');
    }

    playSmoke() {
        this.play('smoke');
    }

    stopSmoke() {
        this.stop('smoke');
    }

    playBreak() {
        this.play('break');
    }

    startAmbient() {
        this.play('ambient');
        this.play('ambient2');
    }

    stopAmbient() {
        const soundData = this.sounds['ambient'];
        if (soundData && soundData.sound.isPlaying) {
            soundData.sound.stop();
        }
        const soundData2 = this.sounds['ambient2'];
        if (soundData2 && soundData2.sound.isPlaying) {
            soundData2.sound.stop();
        }
    }

    isAmbientPlaying() {
        const soundData = this.sounds['ambient'];
        return soundData && soundData.sound.isPlaying;
    }

    setVolume(name, volume) {
        const soundData = this.sounds[name];
        if (soundData) {
            soundData.sound.setVolume(volume);
        }
    }

    setMasterVolume(volume) {
        this.listener.setMasterVolume(volume);
    }
}
