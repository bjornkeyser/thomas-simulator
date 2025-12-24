import * as THREE from 'three';

export class SmokeParticleSystem {
    constructor(scene, hands) {
        this.scene = scene;
        this.hands = hands;

        // Particle settings
        this.maxParticles = 500;
        this.idleSmokeRate = 75; // particles per second
        this.coffeeSteamRate = 30; // coffee steam particles per second
        this.exhaleParticleCount = 30;

        // Particle arrays
        this.particles = [];
        this.idleTimer = 0;
        this.steamTimer = 0;
        this.windTime = 0; // For oscillating wind

        // Create particle geometry and material
        this.geometry = new THREE.BufferGeometry();
        this.positions = new Float32Array(this.maxParticles * 3);
        this.sizes = new Float32Array(this.maxParticles);
        this.opacities = new Float32Array(this.maxParticles);

        this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
        this.geometry.setAttribute('opacity', new THREE.BufferAttribute(this.opacities, 1));

        // Custom shader material for smoke
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                color: { value: new THREE.Color(0xcccccc) }
            },
            vertexShader: `
                attribute float size;
                attribute float opacity;
                varying float vOpacity;

                void main() {
                    vOpacity = opacity;
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = size * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform vec3 color;
                varying float vOpacity;

                void main() {
                    // Circular gradient for soft smoke look
                    vec2 center = gl_PointCoord - vec2(0.5);
                    float dist = length(center);
                    float alpha = smoothstep(0.5, 0.0, dist) * vOpacity;

                    if (alpha < 0.01) discard;

                    gl_FragColor = vec4(color, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });

        // Create points mesh
        this.points = new THREE.Points(this.geometry, this.material);
        this.points.frustumCulled = false;
        scene.add(this.points);
    }

    createParticle(position, velocity, size, lifetime, isExhale = false) {
        return {
            position: position.clone(),
            velocity: velocity.clone(),
            size: size,
            maxSize: size * (isExhale ? 3 : 2),
            opacity: isExhale ? 0.4 : 0.25,
            lifetime: lifetime,
            maxLifetime: lifetime,
            isExhale: isExhale,
            active: true
        };
    }

    spawnIdleSmoke() {
        if (this.particles.length >= this.maxParticles) return;

        const tipPos = this.hands.getCigaretteTipWorldPosition();
        if (!tipPos) return;

        // Random offset from tip
        const offset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.01,
            Math.random() * 0.005,
            (Math.random() - 0.5) * 0.01
        );

        const position = tipPos.add(offset);

        // Upward velocity with slight randomness
        const velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.03,
            0.08 + Math.random() * 0.04,
            (Math.random() - 0.5) * 0.03
        );

        const particle = this.createParticle(
            position,
            velocity,
            0.015 + Math.random() * 0.015, // Larger particles
            4.0 + Math.random() * 2.0  // Much longer lifetime (4-6 seconds)
        );
        particle.opacity = 0.4; // More visible

        this.particles.push(particle);
    }

    spawnCoffeeSteam() {
        if (this.particles.length >= this.maxParticles) return;

        const cupPos = this.hands.getCoffeeCupWorldPosition();
        if (!cupPos) return;

        // Random offset from cup top
        const offset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.03,
            0,
            (Math.random() - 0.5) * 0.03
        );

        const position = cupPos.clone().add(offset);

        // Gentle upward velocity with slight drift
        const velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.025,
            0.06 + Math.random() * 0.03,
            (Math.random() - 0.5) * 0.025
        );

        const particle = this.createParticle(
            position,
            velocity,
            0.01 + Math.random() * 0.01, // Smaller particles
            3.0 + Math.random() * 2.0  // 3-5 seconds lifetime
        );
        particle.isSteam = true;

        this.particles.push(particle);
    }

    triggerExhale() {
        const mouthPos = this.hands.getMouthWorldPosition();
        if (!mouthPos) return;

        // Spawn burst of exhale particles
        for (let i = 0; i < this.exhaleParticleCount; i++) {
            if (this.particles.length >= this.maxParticles) break;

            // Spread pattern
            const spread = 0.3;
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * 0.02;

            const offset = new THREE.Vector3(
                Math.cos(angle) * radius,
                (Math.random() - 0.3) * 0.02,
                -0.01 - Math.random() * 0.02
            );

            const position = mouthPos.clone().add(offset);

            // Forward and slightly upward velocity
            const velocity = new THREE.Vector3(
                (Math.random() - 0.5) * spread * 0.1,
                0.02 + Math.random() * 0.03,
                -0.05 - Math.random() * 0.05
            );

            const particle = this.createParticle(
                position,
                velocity,
                0.02 + Math.random() * 0.02,
                2.0 + Math.random() * 1.0,
                true
            );

            this.particles.push(particle);
        }
    }

    update(deltaTime) {
        // Update wind time for oscillation
        this.windTime += deltaTime;

        // Oscillating wind - multiple frequencies for organic movement
        const windX = Math.sin(this.windTime * 0.8) * 0.15 +
                      Math.sin(this.windTime * 2.1) * 0.08 +
                      Math.sin(this.windTime * 0.3) * 0.10;
        const windZ = Math.cos(this.windTime * 0.6) * 0.12 +
                      Math.sin(this.windTime * 1.7) * 0.06;

        // Spawn idle smoke from cigarette
        this.idleTimer += deltaTime;
        const spawnInterval = 1 / this.idleSmokeRate;

        while (this.idleTimer >= spawnInterval) {
            this.idleTimer -= spawnInterval;
            this.spawnIdleSmoke();
        }

        // Spawn steam from coffee cup
        this.steamTimer += deltaTime;
        const steamInterval = 1 / this.coffeeSteamRate;

        while (this.steamTimer >= steamInterval) {
            this.steamTimer -= steamInterval;
            this.spawnCoffeeSteam();
        }

        // Update all particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];

            // Update lifetime
            p.lifetime -= deltaTime;
            if (p.lifetime <= 0) {
                this.particles.splice(i, 1);
                continue;
            }

            // Apply oscillating wind force (stronger on older particles that have risen)
            const age = 1 - (p.lifetime / p.maxLifetime);
            const windStrength = age * 0.8; // Wind affects older/higher particles more
            p.velocity.x += windX * windStrength * deltaTime;
            p.velocity.z += windZ * windStrength * deltaTime;

            // Update position
            p.position.add(p.velocity.clone().multiplyScalar(deltaTime));

            // Slow down horizontal only, keep rising
            p.velocity.x *= 0.98;
            p.velocity.z *= 0.98;

            // Add slight turbulence
            p.velocity.x += (Math.random() - 0.5) * 0.015 * deltaTime;
            p.velocity.z += (Math.random() - 0.5) * 0.015 * deltaTime;

            // Grow size over time
            const lifeRatio = 1 - (p.lifetime / p.maxLifetime);
            p.size = THREE.MathUtils.lerp(p.size, p.maxSize, lifeRatio * 0.5);

            // Fade out - start fading later for longer visible smoke
            const fadeStart = 0.75;
            if (lifeRatio > fadeStart) {
                const fadeRatio = (lifeRatio - fadeStart) / (1 - fadeStart);
                p.opacity = THREE.MathUtils.lerp(
                    p.isExhale ? 0.4 : 0.3,
                    0,
                    fadeRatio
                );
            }
        }

        // Update GPU buffers
        this.updateBuffers();
    }

    updateBuffers() {
        for (let i = 0; i < this.maxParticles; i++) {
            if (i < this.particles.length) {
                const p = this.particles[i];
                this.positions[i * 3] = p.position.x;
                this.positions[i * 3 + 1] = p.position.y;
                this.positions[i * 3 + 2] = p.position.z;
                this.sizes[i] = p.size;
                this.opacities[i] = p.opacity;
            } else {
                // Hide unused particles
                this.positions[i * 3] = 0;
                this.positions[i * 3 + 1] = -1000;
                this.positions[i * 3 + 2] = 0;
                this.sizes[i] = 0;
                this.opacities[i] = 0;
            }
        }

        this.geometry.attributes.position.needsUpdate = true;
        this.geometry.attributes.size.needsUpdate = true;
        this.geometry.attributes.opacity.needsUpdate = true;
    }

    dispose() {
        this.scene.remove(this.points);
        this.geometry.dispose();
        this.material.dispose();
    }
}
