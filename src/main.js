import * as THREE from 'three';
import {
    createScene,
    createCamera,
    createRenderer,
    createLighting,
    createFloor,
    handleResize,
    loadPanoramaBackground,
    createSunWithLensflare
} from './scene.js';
import { loadModelWithFallback, createFallbackTable } from './loader.js';
import { Hands } from './hands.js';
import { AnimationController } from './animations.js';
import { SmokeParticleSystem } from './particles.js';
import { Controls } from './controls.js';
import { LiquidSimulation } from './liquid.js';
import { PhysicsWorld } from './physics.js';
import { SoundManager } from './sounds.js';
import { FractureSystem } from './fracture.js';

class CafeSimulator {
    constructor() {
        this.clock = new THREE.Clock();
        this.isInitialized = false;

        // Environment objects
        this.table = null;
        this.ashtray = null;

        // Grabbable objects list
        this.grabbableObjects = [];

        // Scoring system
        this.drinkScore = 0;  // Coffee drinks - causes hand shake
        this.smokeScore = 0;  // Cigarettes smoked - causes movement lag

        // Effect tracking
        this.shakeTime = 0;
        this.laggedPosition = null;

        // Mouse position for continuous grab updates
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Loading progress
        this.loadingScreen = document.getElementById('loading-screen');
        this.loadingFill = document.querySelector('.loading-fill');
        this.loadingText = document.querySelector('.loading-text');
        this.loadingProgress = 0;
        this.loadingSteps = 7; // Total loading steps
    }

    updateLoading(step, text) {
        this.loadingProgress = step;
        const percent = Math.round((step / this.loadingSteps) * 100);
        if (this.loadingFill) {
            this.loadingFill.style.width = `${percent}%`;
        }
        if (this.loadingText) {
            this.loadingText.textContent = text;
        }
    }

    hideLoading() {
        if (this.loadingScreen) {
            this.loadingScreen.classList.add('hidden');
            // Remove from DOM after transition
            setTimeout(() => {
                this.loadingScreen.style.display = 'none';
            }, 500);
        }
    }

    async init() {
        // Get canvas
        const canvas = document.getElementById('game-canvas');
        if (!canvas) {
            console.error('Canvas not found!');
            return;
        }

        this.updateLoading(1, 'Setting up scene...');

        // Create core Three.js components
        this.scene = createScene();
        this.camera = createCamera();
        this.renderer = createRenderer(canvas);

        // Setup lighting
        createLighting(this.scene);

        // Add sun with lens flare
        this.sun = createSunWithLensflare(this.scene);

        // Load panorama background (interior Bomboca photo sphere)
        loadPanoramaBackground(this.scene, 'panorama_interior.jpg').catch(() => {
            console.log('No panorama found, using default background');
            // Only create floor as fallback when no panorama
            createFloor(this.scene);
        });

        this.updateLoading(2, 'Loading environment...');

        // Load environment (table)
        await this.loadEnvironment();

        this.updateLoading(3, 'Loading items...');

        // Setup items (cup and cigarette on table, in world space)
        this.hands = new Hands(this.camera, this.scene);
        await this.hands.init();

        // Add camera to scene for proper transforms
        this.scene.add(this.camera);

        this.updateLoading(4, 'Setting up physics...');

        // Create particle system
        this.particles = new SmokeParticleSystem(this.scene, this.hands);

        // Create physics world first (moved before liquid)
        this.physics = new PhysicsWorld();

        // Track multiple liquid simulations (one per cup)
        this.liquids = new Map(); // Map<cup, LiquidSimulation>

        // Create liquid simulation for initial coffee cup
        const initialCup = this.hands.getCoffeeCup();
        const initialLiquid = new LiquidSimulation(this.scene, initialCup, this.physics.world);
        this.liquids.set(initialCup, initialLiquid);

        // Keep reference to "active" liquid for UI meter (most recent unbroken cup)
        this.activeLiquid = initialLiquid;

        // Create animation controller
        this.animation = new AnimationController(this.hands, this.particles);

        // Setup controls (keyboard + mouse look)
        this.controls = new Controls(this.animation, this.camera);

        this.updateLoading(5, 'Loading sounds...');

        // Setup sound system
        this.sounds = new SoundManager(this.camera);
        await this.sounds.init();

        this.updateLoading(6, 'Setting up interactions...');

        // Setup physics (world already created above)
        this.setupPhysics();

        // Setup fracture system for breakable objects
        this.fracture = new FractureSystem(this.scene, this.physics.world);

        // Register cup as breakable (threshold ~2 = gentle drop won't break, hard throw will)
        const cup = this.hands.getCoffeeCup();
        if (cup) {
            this.physics.registerBreakable(cup, 2.0, (mesh, body, impactPoint, force) => {
                console.log('Cup breaking!');
                // Play breaking sound
                if (this.sounds) {
                    this.sounds.playBreak();
                }

                // Remove from grabbables
                const idx = this.grabbableObjects.indexOf(mesh);
                if (idx > -1) this.grabbableObjects.splice(idx, 1);

                // Fracture the cup
                this.fracture.fracture(mesh, body, impactPoint, force * 2, 10);

                // Spill liquid for this specific cup
                const liquid = this.liquids.get(mesh);
                if (liquid) {
                    liquid.spillAll(impactPoint);
                    this.liquids.delete(mesh);
                }

                // Disable steam if this was the active cup
                if (mesh === this.hands.getCoffeeCup() && this.particles) {
                    this.particles.setSteamEnabled(false);
                }

                // Hide coffee meter if no cups left
                if (this.liquids.size === 0 && this.coffeeMeter) {
                    this.coffeeMeter.style.display = 'none';
                    this.cupBroken = true;
                }
            });
        }

        // Setup mouse interaction for grabbing
        this.setupMouseInteraction(canvas);

        // Handle window resize
        handleResize(this.camera, this.renderer);

        // Get meter UI elements
        this.coffeeMeter = document.getElementById('coffee-meter');
        this.coffeeFill = document.querySelector('.coffee-fill');
        this.cigaretteMeter = document.getElementById('cigarette-meter');
        this.cigaretteFill = document.querySelector('.cigarette-fill');

        // Setup action buttons
        this.setupActionButtons();

        this.updateLoading(7, 'Ready!');

        this.isInitialized = true;
        console.log('Cafe Simulator initialized!');
        console.log('Drag objects down toward mouth to drink/smoke!');

        // Ambient sound will auto-start when audio context is resumed on first user interaction
        // (handled by SoundManager.setupContextResume)

        // Hide loading screen
        setTimeout(() => this.hideLoading(), 300);

        // Start render loop
        this.animate();
    }

    async loadEnvironment() {
        const { loadModel } = await import('./loader.js');

        // Load wooden table
        try {
            this.table = await loadModel('models/wooden_table_painted.glb', {
                position: { x: 0.44, y: 0.2, z: -0.26 },
                scale: 0.6,
                rotation: { x: 0, y: -Math.PI / 3, z: 0 } // Rotate 60° right (90° - 30°)
            });
            this.table.name = 'table';
            this.scene.add(this.table);
            console.log('Wooden table loaded');

            // Load ashtray and place on table (same height as cup)
            try {
                this.ashtray = await loadModel('models/ashtray_with_cigarettes.glb', {
                    position: { x: 0.26, y: 0.72, z: -0.25 }, // On table surface, rotated 30° right
                    scale: 0.8
                });
                this.ashtray.name = 'ashtray';
                this.scene.add(this.ashtray);
                console.log('Ashtray loaded');
            } catch (e) {
                console.log('No ashtray model found');
            }
        } catch (e) {
            console.log('No table model, using panorama background only');
        }
    }

    setupPhysics() {
        // Create floor/ground plane (static)
        this.physics.createStaticBox(null, { x: 10, y: 0.1, z: 10 }, { x: 0, y: -0.05, z: 0 });

        // Create table surface collider (shrunk to 70%, rotated 30° CCW)
        if (this.table) {
            this.physics.createStaticSurface(this.table, 0.7, Math.PI / 6);
        }

        // Create ashtray surface collider
        if (this.ashtray) {
            this.physics.createStaticSurface(this.ashtray);
        }

        // Get the coffee cup and cigarette
        const cup = this.hands.getCoffeeCup();
        const cigarette = this.hands.getCigarette();

        // Create dynamic body for coffee cup
        if (cup) {
            this.physics.createDynamicCylinder(cup, 0.04, 0.08, 0.5);
            this.grabbableObjects.push(cup);
        }

        // Create dynamic body for cigarette
        if (cigarette) {
            this.physics.createDynamicBox(cigarette,
                { x: 0.08, y: 0.01, z: 0.01 },
                0.05
            );
            this.grabbableObjects.push(cigarette);
        }

        // Enable physics control for items
        this.hands.setCupPhysicsControlled(true);
        this.hands.setCigarettePhysicsControlled(true);

        console.log('Physics initialized with', this.grabbableObjects.length, 'grabbable objects');
    }

    setupMouseInteraction(canvas) {
        let isGrabbing = false;
        let actionTriggered = false;
        let drinkSoundPlayed = false;
        const debugEl = document.getElementById('debug');

        canvas.addEventListener('mousedown', (e) => {
            // Only grab with left click
            if (e.button !== 0) return;

            // Don't grab if animation is playing
            if (this.animation.isAnimating()) return;

            const grabbed = this.physics.tryGrab(e.clientX, e.clientY, this.camera, this.grabbableObjects);
            if (grabbed) {
                isGrabbing = true;
                actionTriggered = false;
                drinkSoundPlayed = false; // Reset drink sound flag
                this.controls.setEnabled(false); // Disable camera rotation while grabbing
                canvas.style.cursor = 'grabbing';
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            // Always track mouse position for continuous grab updates
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            // Check if hovering over grabbable object (when not grabbing)
            if (!isGrabbing) {
                const isOverGrabbable = this.physics.checkHover(e.clientX, e.clientY, this.camera, this.grabbableObjects);
                canvas.style.cursor = isOverGrabbable ? 'grab' : 'default';
            }

            if (isGrabbing) {
                const enteredMouthZone = this.physics.updateGrab(e.clientX, e.clientY, this.camera, this.drinkScore, this.smokeScore);

                // Debug display
                const grabbed = this.physics.getGrabbedMesh();
                const isCup = grabbed?.name === 'coffee-cup';
                const isCig = grabbed?.name === 'cigarette';
                debugEl.textContent = `Near: ${this.physics.isNearMouth} | Obj: ${grabbed?.name} | Cup: ${isCup} | Cig: ${isCig} | Tilt: ${this.hands.cupTilt.toFixed(2)}`;

                // Debug display for cigarette (rotation now handled by constraint physics)
                if (isCig) {
                    debugEl.textContent = `🚬 CIG! Progress: ${this.physics.depthProgress.toFixed(2)}`;
                }

                // Smoothly tilt cup when near mouth and increment drink score
                if (this.physics.isNearMouth && isCup) {
                    this.hands.cupTilt = Math.min(0.6, this.hands.cupTilt + 0.04);
                    // Increment drink score while drinking (very slowly)
                    if (this.hands.cupTilt > 0.3) {
                        this.drinkScore += 0.002;
                        // Coffee counteracts smoking lag (antagonist)
                        this.smokeScore = Math.max(0, this.smokeScore - 0.02);
                        // Play sip sound once per drink
                        if (!drinkSoundPlayed && this.sounds) {
                            this.sounds.playSip();
                            drinkSoundPlayed = true;
                        }
                    }
                    debugEl.textContent = `🍵 DRINKING! ☕${this.drinkScore.toFixed(1)} 🚬${this.smokeScore.toFixed(1)}`;
                }

                // Trigger smoke exhale once when cigarette near mouth
                if (this.physics.isNearMouth && isCig && !actionTriggered) {
                    actionTriggered = true;
                    this.smokeScore += 1; // Increment smoke score
                    // Smoking calms coffee jitters (antagonist)
                    this.drinkScore = Math.max(0, this.drinkScore - 0.5);
                    // Burn the cigarette down
                    this.hands.burnCigarette(0.08);
                    // Play smoke sound
                    if (this.sounds) {
                        this.sounds.playSmoke();
                    }
                    this.triggerSmokeAction();
                    debugEl.textContent = `🚬 SMOKING! ☕${this.drinkScore.toFixed(1)} 🚬${this.smokeScore.toFixed(1)} 🔥${(this.hands.getCigaretteBurnLevel() * 100).toFixed(0)}%`;
                }

                // Grow tip continuously while cigarette is at mouth - no cap
                if (this.physics.isNearMouth && isCig) {
                    this.tipGrowth = (this.tipGrowth || 0) + 0.01; // Half speed growth, no cap
                    this.hands.setTipGlow(this.tipGrowth);
                }

                // Reset action if moved away from mouth
                if (!this.physics.isNearMouth) {
                    actionTriggered = false;
                    // Stop smoke sound when moving away
                    if (this.sounds) {
                        this.sounds.stopSmoke();
                    }
                    // Reset tip to default size instantly
                    if (isCig) {
                        this.tipGrowth = 0;
                        this.hands.setTipGlow(0);
                    }
                    // Smoothly reset cup tilt when moving away
                    if (this.hands.cupTilt > 0) {
                        this.hands.cupTilt = Math.max(0, this.hands.cupTilt - 0.04);
                    }
                }
            } else {
                debugEl.textContent = '';
            }
        });

        canvas.addEventListener('mouseup', (e) => {
            if (isGrabbing) {
                const wasHoldingCup = this.physics.getGrabbedMesh()?.name === 'coffee-cup';
                this.hands.cupTilt = 0;
                this.physics.release();
                isGrabbing = false;
                actionTriggered = false;
                this.controls.setEnabled(true);
                canvas.style.cursor = 'default';

                // Stop smoke sound on release
                if (this.sounds) {
                    this.sounds.stopSmoke();
                }

                // Play cup tap sound immediately on release
                if (wasHoldingCup && this.sounds) {
                    this.sounds.playCupTap();
                }
            }
        });

        canvas.addEventListener('mouseleave', () => {
            if (isGrabbing) {
                this.hands.cupTilt = 0;
                this.physics.release();
                isGrabbing = false;
                actionTriggered = false;
                this.controls.setEnabled(true);
                canvas.style.cursor = 'default';

                // Stop smoke sound on leave
                if (this.sounds) {
                    this.sounds.stopSmoke();
                }
            }
        });
    }

    setupActionButtons() {
        const newCoffeeBtn = document.getElementById('new-coffee-btn');
        const newCigaretteBtn = document.getElementById('new-cigarette-btn');

        if (newCoffeeBtn) {
            newCoffeeBtn.addEventListener('click', () => this.spawnNewCoffee());
        }

        if (newCigaretteBtn) {
            newCigaretteBtn.addEventListener('click', () => this.spawnNewCigarette());
        }
    }

    async spawnNewCoffee() {
        const { loadModelWithFallback, createFallbackCup } = await import('./loader.js');

        // Create new coffee cup
        const cup = await loadModelWithFallback(
            'models/coffee_cup.glb',
            createFallbackCup,
            { scale: 0.04 }
        );
        cup.name = 'coffee-cup';
        this.scene.add(cup);

        // Position slightly above table
        const spawnPos = this.hands.cupTablePosition.clone();
        spawnPos.y += 0.15; // Spawn above table so it falls
        cup.position.copy(spawnPos);
        cup.rotation.y = Math.PI + Math.PI / 6;

        // Update hands reference
        this.hands.coffeeCup = cup;
        this.hands.cupPhysicsControlled = true;

        // Create physics body
        this.physics.createDynamicCylinder(cup, 0.04, 0.08, 0.5);
        this.grabbableObjects.push(cup);

        // Register as breakable
        this.physics.registerBreakable(cup, 2.0, (mesh, body, impactPoint, force) => {
            console.log('Cup breaking!');
            if (this.sounds) this.sounds.playBreak();

            const idx = this.grabbableObjects.indexOf(mesh);
            if (idx > -1) this.grabbableObjects.splice(idx, 1);

            this.fracture.fracture(mesh, body, impactPoint, force * 2, 10);

            // Spill liquid for this specific cup
            const liquid = this.liquids.get(mesh);
            if (liquid) {
                liquid.spillAll(impactPoint);
                this.liquids.delete(mesh);
            }

            // Disable steam if this was the active cup
            if (mesh === this.hands.getCoffeeCup() && this.particles) {
                this.particles.setSteamEnabled(false);
            }

            // Hide coffee meter if no cups left
            if (this.liquids.size === 0 && this.coffeeMeter) {
                this.coffeeMeter.style.display = 'none';
                this.cupBroken = true;
            }
        });

        // Create new liquid simulation for this cup
        const newLiquid = new LiquidSimulation(this.scene, cup, this.physics.world);
        this.liquids.set(cup, newLiquid);
        this.activeLiquid = newLiquid; // This is now the active cup for UI

        // Re-enable steam for new cup
        if (this.particles) {
            this.particles.setSteamEnabled(true);
        }

        // Reset broken flag and show coffee meter again
        this.cupBroken = false;
        if (this.coffeeMeter) {
            this.coffeeMeter.style.display = 'flex';
        }

        console.log('New coffee spawned!');
    }

    async spawnNewCigarette() {
        const { createFallbackCigarette } = await import('./loader.js');

        // Create new cigarette using fallback (GLB model has issues)
        const cigarette = createFallbackCigarette();
        cigarette.name = 'cigarette';
        this.scene.add(cigarette);

        // Position slightly above table so it falls
        const spawnPos = this.hands.cigaretteTablePosition.clone();
        spawnPos.y += 0.1;
        cigarette.position.copy(spawnPos);
        cigarette.rotation.set(0, Math.PI / 2, 0.2);

        // Update hands reference
        this.hands.cigarette = cigarette;
        this.hands.cigaretteBurnLevel = 1.0; // Reset burn level
        this.hands.cigarettePhysicsControlled = true;

        // Create physics body
        this.physics.createDynamicBox(cigarette, { x: 0.08, y: 0.01, z: 0.01 }, 0.05);
        this.grabbableObjects.push(cigarette);

        // Show cigarette meter and reset fill
        if (this.cigaretteMeter) {
            this.cigaretteMeter.style.display = 'flex';
        }
        if (this.cigaretteFill) {
            this.cigaretteFill.style.width = '100%';
        }

        console.log('New cigarette spawned!');
    }

    triggerDrinkAction() {
        // Tilt cup for drinking
        this.hands.cupTilt = 0.6;
        console.log('Drinking!');
    }

    triggerSmokeAction() {
        // Trigger exhale smoke after brief inhale
        console.log('Smoking!');
        setTimeout(() => {
            this.particles.triggerExhale();
        }, 500);

        // Maybe trigger a cough after smoking
        // Base 30% chance + 15% per smokeScore point (capped at 90%)
        const coughChance = Math.min(0.9, 0.3 + this.smokeScore * 0.15);
        if (Math.random() < coughChance) {
            // Delay cough to happen after exhale
            const coughDelay = 800 + Math.random() * 1200; // 0.8-2 seconds after smoking
            setTimeout(() => {
                if (this.sounds) {
                    this.sounds.playCough();
                    console.log(`Cough! (chance was ${(coughChance * 100).toFixed(0)}%)`);
                }
            }, coughDelay);
        }
    }

    updateMeters() {
        // Ensure camera matrices are up to date
        this.camera.updateMatrixWorld();

        // Project 3D positions to screen coordinates
        const cup = this.hands.getCoffeeCup();
        const cig = this.hands.getCigarette();

        // Get canvas dimensions
        const canvas = this.renderer.domElement;
        const rect = canvas.getBoundingClientRect();

        if (cup && this.coffeeMeter && !this.cupBroken) {
            const cupPos = new THREE.Vector3();
            cup.getWorldPosition(cupPos);
            cupPos.y += 0.15; // Offset above the cup

            // Project to normalized device coordinates
            const projected = cupPos.clone().project(this.camera);

            // Convert to screen coordinates
            const x = (projected.x * 0.5 + 0.5) * rect.width;
            const y = (-projected.y * 0.5 + 0.5) * rect.height;

            // Only show if in front of camera
            if (projected.z < 1) {
                this.coffeeMeter.style.left = `${x}px`;
                this.coffeeMeter.style.top = `${y}px`;
                this.coffeeMeter.style.display = 'flex';
            } else {
                this.coffeeMeter.style.display = 'none';
            }

            // Show liquid level for active cup
            if (this.activeLiquid) {
                const coffeeLevel = this.activeLiquid.liquidLevel / this.activeLiquid.maxLiquidLevel;
                this.coffeeFill.style.width = `${coffeeLevel * 100}%`;
            }
        } else if (this.cupBroken && this.coffeeMeter) {
            this.coffeeMeter.style.display = 'none';
        }

        if (cig && this.cigaretteMeter) {
            const cigPos = new THREE.Vector3();
            cig.getWorldPosition(cigPos);
            cigPos.y += 0.08; // Offset above the cigarette

            // Project to normalized device coordinates
            const projected = cigPos.clone().project(this.camera);

            // Convert to screen coordinates
            const x = (projected.x * 0.5 + 0.5) * rect.width;
            const y = (-projected.y * 0.5 + 0.5) * rect.height;

            // Only show if in front of camera
            if (projected.z < 1) {
                this.cigaretteMeter.style.left = `${x}px`;
                this.cigaretteMeter.style.top = `${y}px`;
                this.cigaretteMeter.style.display = 'flex';
            } else {
                this.cigaretteMeter.style.display = 'none';
            }

            const burnLevel = this.hands.getCigaretteBurnLevel();
            this.cigaretteFill.style.width = `${burnLevel * 100}%`;
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        if (!this.isInitialized) return;

        const deltaTime = this.clock.getDelta();

        // Update physics
        this.physics.update(deltaTime);

        // Continuously update grab position for shake effect (even when mouse stationary)
        if (this.physics.isGrabbing()) {
            this.physics.updateGrab(this.lastMouseX, this.lastMouseY, this.camera, this.drinkScore, this.smokeScore);
        }

        // Decay smoke lag effect over time (shake persists permanently)
        if (this.smokeScore > 0) {
            this.smokeScore = Math.max(0, this.smokeScore - deltaTime * 0.08); // ~12 sec to lose 1 point
        }

        // Update animation (for D/S key actions)
        this.animation.update(deltaTime);

        // Update hands/items positions
        this.hands.update();

        // Tip glow is now reset instantly when not smoking (no fading needed)

        // Update all liquid simulations
        for (const liquid of this.liquids.values()) {
            liquid.update(deltaTime);
        }

        // Update particles
        this.particles.update(deltaTime);

        // Update fracture fragments
        if (this.fracture) {
            this.fracture.update();
        }

        // Update UI meters
        this.updateMeters();

        // Render
        this.renderer.render(this.scene, this.camera);
    }
}

// Start the game
const game = new CafeSimulator();
game.init().catch(console.error);
