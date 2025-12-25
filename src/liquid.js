import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export class LiquidSimulation {
    constructor(scene, cup, physicsWorld = null, texturePath = 'coffeetexture.jpg') {
        this.scene = scene;
        this.cup = cup;
        this.physicsWorld = physicsWorld; // cannon-es world for droplet physics
        this.texturePath = texturePath;

        // Liquid properties - in cup's local coordinates (cup is scaled 0.04)
        this.cupRadius = 0.8;        // Inner radius of cup in local space
        this.cupRimHeight = 1.0;     // Height of rim from cup bottom
        this.liquidLevel = 0.9;      // Current liquid level in local space
        this.maxLiquidLevel = 0.9;

        // Heightfield grid
        this.gridSize = 32;          // 16x16 grid
        this.heights = [];           // Current heights
        this.velocities = [];        // Vertical velocities

        // Wave physics - adjusted for local coordinate scale
        this.damping = 0.9;        // How fast waves settle (higher = more sloshy/liquidy)
        this.waveSpeed = 4.0;        // Wave propagation speed (higher = snappier waves)
        this.gravity = 2.5;          // Gravity pulling liquid to settle
        this.maxHeight = 0.5;        // Maximum wave height in local space
        this.maxVelocity = 3.0;      // Maximum wave velocity
        this.velocityThreshold = 0.01; // Kill tiny oscillations below this

        // Tilt tracking for angular acceleration
        this.prevTiltX = 0;
        this.prevTiltZ = 0;
        this.tiltVelX = 0;
        this.tiltVelZ = 0;

        // Position tracking for translational acceleration
        this.prevVelocity = new THREE.Vector3();
        this.cupAcceleration = new THREE.Vector3();

        // Spill tracking
        this.droplets = [];
        this.maxDroplets = 200;      // More droplets for big spills
        this.spillThreshold = 0.2;   // How much over rim before spill
        this.totalSpilled = 0;

        // Previous cup state for acceleration
        this.prevCupPos = new THREE.Vector3();
        this.cupVelocity = new THREE.Vector3();
        this.initialized = false;

        // Initialize heightfield
        this.initHeightfield();

        // Create liquid mesh
        this.createLiquidMesh();

        // Create droplet system
        this.createDropletSystem();
    }

    initHeightfield() {
        for (let i = 0; i < this.gridSize * this.gridSize; i++) {
            this.heights.push(0);
            this.velocities.push(0);
        }
    }

    resetHeightfield() {
        for (let i = 0; i < this.gridSize * this.gridSize; i++) {
            this.heights[i] = 0;
            this.velocities[i] = 0;
        }
    }

    createLiquidMesh() {
        // Create a grid-based circular liquid surface
        const gridRes = this.gridSize;  // Match heightfield resolution
        const liquidDepth = 0.015;

        // Create a group to hold the liquid parts
        this.liquidMesh = new THREE.Group();
        this.liquidMesh.name = 'coffee-liquid';

        // Add liquid as child of cup so it inherits rotation correctly
        this.cup.add(this.liquidMesh);

        // Build custom grid geometry masked to circle
        this.topGeometry = new THREE.BufferGeometry();

        const vertices = [];
        const indices = [];
        const vertexMap = {}; // Map grid coords to vertex index

        // Create vertices for grid points inside circle
        let vertexIndex = 0;
        for (let gy = 0; gy < gridRes; gy++) {
            for (let gx = 0; gx < gridRes; gx++) {
                // Convert to local coords (-radius to +radius)
                const x = (gx / (gridRes - 1) - 0.5) * 2 * this.cupRadius;
                const z = (gy / (gridRes - 1) - 0.5) * 2 * this.cupRadius;

                // Check if inside circle
                const dist = Math.sqrt(x * x + z * z);
                if (dist <= this.cupRadius * 1.1) { // Slight margin
                    vertices.push(x, 0, z);
                    vertexMap[`${gx},${gy}`] = vertexIndex;
                    vertexIndex++;
                }
            }
        }

        // Create triangles for adjacent grid cells inside circle
        for (let gy = 0; gy < gridRes - 1; gy++) {
            for (let gx = 0; gx < gridRes - 1; gx++) {
                const v00 = vertexMap[`${gx},${gy}`];
                const v10 = vertexMap[`${gx+1},${gy}`];
                const v01 = vertexMap[`${gx},${gy+1}`];
                const v11 = vertexMap[`${gx+1},${gy+1}`];

                // Only create triangles if all 4 corners exist
                if (v00 !== undefined && v10 !== undefined &&
                    v01 !== undefined && v11 !== undefined) {
                    // Two triangles per grid cell
                    indices.push(v00, v10, v11);
                    indices.push(v00, v11, v01);
                }
            }
        }

        this.topGeometry.setAttribute('position',
            new THREE.Float32BufferAttribute(vertices, 3));
        this.topGeometry.setIndex(indices);
        this.topGeometry.computeVertexNormals();

        // Store original positions and grid mapping
        this.originalPositions = new Float32Array(vertices);
        this.vertexMap = vertexMap;

        // Load coffee texture
        const textureLoader = new THREE.TextureLoader();
        this.coffeeTexture = textureLoader.load(this.texturePath, (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
        });

        // Create distortion data texture (stores velocities for UV distortion)
        this.distortionSize = this.gridSize;
        this.distortionData = new Float32Array(this.distortionSize * this.distortionSize * 4);
        this.distortionTexture = new THREE.DataTexture(
            this.distortionData,
            this.distortionSize,
            this.distortionSize,
            THREE.RGBAFormat,
            THREE.FloatType
        );
        this.distortionTexture.needsUpdate = true;

        // Custom shader material with UV distortion
        this.liquidMaterial = new THREE.ShaderMaterial({
            uniforms: {
                coffeeTexture: { value: this.coffeeTexture },
                distortionMap: { value: this.distortionTexture },
                distortionStrength: { value: 0.35 },
                time: { value: 0 },
                baseColor: { value: new THREE.Color(0x3d2314) }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vNormal;

                void main() {
                    vUv = vec2(
                        (position.x / ${this.cupRadius.toFixed(2)} + 1.0) * 0.5,
                        (position.z / ${this.cupRadius.toFixed(2)} + 1.0) * 0.5
                    );
                    vNormal = normalMatrix * normal;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D coffeeTexture;
                uniform sampler2D distortionMap;
                uniform float distortionStrength;
                uniform float time;
                uniform vec3 baseColor;

                varying vec2 vUv;
                varying vec3 vNormal;

                void main() {
                    // Sample distortion from velocity data
                    vec4 distortion = texture2D(distortionMap, vUv);

                    // Distort UV based on wave velocities (stored in RG channels)
                    vec2 distortedUv = vUv + distortion.rg * distortionStrength;

                    // Sample coffee texture with distorted UVs - use texture directly
                    vec3 finalColor = texture2D(coffeeTexture, distortedUv).rgb;

                    // Add subtle specular highlight based on distortion
                    float spec = pow(max(0.0, distortion.b), 2.0) * 0.3;
                    finalColor += vec3(spec);

                    // Darken edges slightly for depth
                    float edgeDist = length(vUv - 0.5) * 2.0;
                    finalColor *= 1.0 - edgeDist * 0.15;

                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide
        });

        this.topMesh = new THREE.Mesh(this.topGeometry, this.liquidMaterial);
        this.topMesh.position.y = 0.02; // Raise slightly above body
        this.topMesh.renderOrder = 1; // Render on top
        this.liquidMesh.add(this.topMesh);

        // Add a cylinder body underneath the surface to fill gaps when tilting
        // Use open-ended cylinder (no top cap) so it doesn't show through
        const bodyHeight = 1.5; // Height of liquid body
        const bodyGeometry = new THREE.CylinderGeometry(
            this.cupRadius * 0.95,  // Top radius (slightly smaller)
            this.cupRadius * 0.9,   // Bottom radius
            bodyHeight,             // Height
            32,                     // Segments
            1,                      // Height segments
            true                    // Open ended - no top/bottom caps
        );

        // Use same coffee texture for cylinder sides
        const bodyMaterial = new THREE.MeshStandardMaterial({
            map: this.coffeeTexture,
            roughness: 0.3,
            metalness: 0.0,
            side: THREE.DoubleSide
        });
        this.bodyMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
        this.bodyMesh.position.y = -bodyHeight / 2; // Position below surface
        this.bodyMesh.renderOrder = 0; // Render first
        this.liquidMesh.add(this.bodyMesh);
    }

    createDropletSystem() {
        // Physics-based droplet system using cannon-es
        this.dropletRadius = 0.003; // Small droplet radius
        this.dropletShape = new CANNON.Sphere(this.dropletRadius);

        // Flat circle geometry for droplets (like stains but in-flight)
        const geometry = new THREE.CircleGeometry(0.006, 8);
        const dropletMaterial = new THREE.MeshBasicMaterial({
            color: 0xc4a35a, // Placeholder - will be updated from texture
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        this.dropletMaterial = dropletMaterial;

        // Calculate average color from coffee texture
        this.calculateAverageTextureColor(this.texturePath, (avgColor) => {
            dropletMaterial.color.setRGB(avgColor.r, avgColor.g, avgColor.b);
            dropletMaterial.needsUpdate = true;
            // Also update stain color (20% darker)
            this.stainMaterial.color.setRGB(avgColor.r * 0.8, avgColor.g * 0.8, avgColor.b * 0.8);
            console.log('Droplet color set from texture average:', avgColor);
        });

        const material = dropletMaterial;

        // Stain system
        this.stains = [];
        this.maxStains = 300;        // Allow many stains for big spills

        // Create coffee ring shader material (drying effect over time)
        this.stainMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0x8b6914) }, // Lighter coffee brown
                uOpacity: { value: 0.4 },
                uDryness: { value: 0.0 } // 0 = fresh, 1 = fully dried with ring
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                uniform float uOpacity;
                uniform float uDryness;
                varying vec2 vUv;

                void main() {
                    vec2 centered = vUv - 0.5;
                    float dist = length(centered) * 2.0;

                    // Edge fades
                    float innerFade = smoothstep(0.0, 0.4, dist);
                    float outerFade = 1.0 - smoothstep(0.85, 1.0, dist);
                    float ringDark = smoothstep(0.5, 0.85, dist);

                    // Coffee ring develops as stain dries
                    // Fresh: uniform color, Dry: dark edges, light center
                    float ringEffect = ringDark * uDryness;
                    vec3 finalColor = uColor * (1.0 - ringEffect * 0.4);

                    // Center becomes more transparent as it dries
                    float centerFade = mix(1.0, 0.3 + ringDark * 0.7, uDryness);
                    float alpha = uOpacity * innerFade * outerFade * centerFade;

                    gl_FragColor = vec4(finalColor, alpha);
                }
            `,
            transparent: true,
            depthWrite: false
        });
        this.stainMaterial.polygonOffset = true;
        this.stainMaterial.polygonOffsetFactor = -1;

        this.dropletInstancedMesh = new THREE.InstancedMesh(geometry, material, 200);
        this.dropletInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.dropletInstancedMesh.count = 0;
        this.dropletInstancedMesh.frustumCulled = false;
        this.scene.add(this.dropletInstancedMesh);

        // Initialize all instance matrices
        const dummy = new THREE.Object3D();
        for (let i = 0; i < 200; i++) {
            dummy.position.set(0, -100, 0);
            dummy.updateMatrix();
            this.dropletInstancedMesh.setMatrixAt(i, dummy.matrix);
        }
        this.dropletInstancedMesh.instanceMatrix.needsUpdate = true;

        // Track physics bodies
        this.dropletBodies = [];
    }

    // Get height at a grid position
    getHeight(x, y) {
        if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return 0;
        return this.heights[y * this.gridSize + x];
    }

    // Set height at a grid position
    setHeight(x, y, h) {
        if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return;
        this.heights[y * this.gridSize + x] = h;
    }

    // Get velocity at grid position
    getVelocity(x, y) {
        if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return 0;
        return this.velocities[y * this.gridSize + x];
    }

    // Set velocity at grid position
    setVelocity(x, y, v) {
        if (x < 0 || x >= this.gridSize || y < 0 || y >= this.gridSize) return;
        this.velocities[y * this.gridSize + x] = v;
    }

    // Convert grid coords to local position
    gridToLocal(gx, gy) {
        const x = (gx / (this.gridSize - 1) - 0.5) * 2 * this.cupRadius;
        const z = (gy / (this.gridSize - 1) - 0.5) * 2 * this.cupRadius;
        return { x, z };
    }

    // Check if grid position is inside circular cup (with margin for edge vertices)
    isInsideCup(gx, gy) {
        const pos = this.gridToLocal(gx, gy);
        return Math.sqrt(pos.x * pos.x + pos.z * pos.z) <= this.cupRadius * 1.2;
    }

    update(deltaTime) {
        if (!this.cup) return;

        // Get cup world position and rotation
        const cupWorldPos = new THREE.Vector3();
        this.cup.getWorldPosition(cupWorldPos);
        const cupTilt = this.cup.rotation.x;

        // First frame initialization
        if (!this.initialized) {
            this.prevCupPos.copy(cupWorldPos);
            this.prevTiltX = this.cup.rotation.x;
            this.prevTiltZ = this.cup.rotation.z;
            this.initialized = true;
            this.updateLiquidMesh(cupWorldPos, cupTilt);
            return;
        }

        // Check if cup teleported (not normal animation movement)
        const distMoved = cupWorldPos.distanceTo(this.prevCupPos);
        if (distMoved > 1.0) {
            // Cup teleported - reset to prevent explosion
            this.resetHeightfield();
            this.prevTiltX = this.cup.rotation.x;
            this.prevTiltZ = this.cup.rotation.z;
            this.tiltVelX = 0;
            this.tiltVelZ = 0;
        }

        // Calculate cup velocity and acceleration
        const dt = deltaTime || 0.016;
        const newVelocity = new THREE.Vector3().subVectors(cupWorldPos, this.prevCupPos).divideScalar(dt);

        // Calculate acceleration (change in velocity)
        this.cupAcceleration.subVectors(newVelocity, this.prevVelocity).divideScalar(dt);

        // Clamp acceleration to prevent explosion
        this.cupAcceleration.clampLength(0, 50);

        this.cupVelocity.copy(newVelocity);
        this.prevVelocity.copy(newVelocity);
        this.prevCupPos.copy(cupWorldPos);

        // Apply physics forces (gravity + inertia from tilt + translational acceleration)
        this.applyPhysicsForces(dt);

        // Update wave physics
        this.updateWavePhysics(dt);

        // Check for spills
        this.checkSpills(cupWorldPos, cupTilt);

        // Update droplets
        this.updateDroplets(deltaTime);

        // Update stain fading
        this.updateStains(deltaTime);

        // Update distortion texture with wave data
        this.updateDistortionTexture();

        // Update liquid mesh position and shape
        this.updateLiquidMesh(cupWorldPos, cupTilt);

        // Update shader time uniform
        if (this.liquidMaterial.uniforms) {
            this.liquidMaterial.uniforms.time.value += deltaTime;
        }
    }

    updateDistortionTexture() {
        // Pack velocity and height data into distortion texture
        // R = velocity X gradient, G = velocity Z gradient, B = height for specular
        for (let gy = 0; gy < this.gridSize; gy++) {
            for (let gx = 0; gx < this.gridSize; gx++) {
                const idx = (gy * this.gridSize + gx) * 4;

                // Calculate local gradients for distortion direction
                const h = this.getHeight(gx, gy);
                const hLeft = this.getHeight(gx - 1, gy);
                const hRight = this.getHeight(gx + 1, gy);
                const hUp = this.getHeight(gx, gy - 1);
                const hDown = this.getHeight(gx, gy + 1);

                const gradX = (hRight - hLeft) * 0.5;
                const gradZ = (hDown - hUp) * 0.5;

                // Store gradient and height for shader
                this.distortionData[idx] = gradX;     // R - X distortion
                this.distortionData[idx + 1] = gradZ; // G - Z distortion
                this.distortionData[idx + 2] = Math.abs(h) + Math.abs(this.getVelocity(gx, gy)) * 0.5; // B - for specular
                this.distortionData[idx + 3] = 1.0;   // A
            }
        }

        this.distortionTexture.needsUpdate = true;
    }

    applyPhysicsForces(dt) {
        // Get cup's current tilt from rotation
        const tiltX = this.cup.rotation.x;  // Forward/back tilt
        const tiltZ = this.cup.rotation.z;  // Left/right tilt

        // Calculate angular velocity (how fast cup is rotating)
        const angularVelX = (tiltX - this.prevTiltX) / dt;
        const angularVelZ = (tiltZ - this.prevTiltZ) / dt;

        // Calculate angular acceleration (change in rotation speed)
        const angularAccelX = (angularVelX - this.tiltVelX) / dt;
        const angularAccelZ = (angularVelZ - this.tiltVelZ) / dt;

        // Clamp accelerations to prevent explosion
        const clampedAccelX = Math.max(-50, Math.min(50, angularAccelX));
        const clampedAccelZ = Math.max(-50, Math.min(50, angularAccelZ));

        // Store for next frame
        this.prevTiltX = tiltX;
        this.prevTiltZ = tiltZ;
        this.tiltVelX = angularVelX;
        this.tiltVelZ = angularVelZ;

        for (let gy = 0; gy < this.gridSize; gy++) {
            for (let gx = 0; gx < this.gridSize; gx++) {
                // Apply forces to ALL grid cells (not just inside cup)
                // This ensures uniform gravity response across the surface

                // Position relative to center (-1 to 1)
                const relX = (gx / (this.gridSize - 1) - 0.5) * 2;
                const relZ = (gy / (this.gridSize - 1) - 0.5) * 2;

                let vel = this.getVelocity(gx, gy);
                const h = this.getHeight(gx, gy);

                // 1. GRAVITY: Liquid wants to be level (opposite to cup tilt)
                // When cup tilts forward (positive X rotation), liquid should pile up at back
                const targetHeight = -relZ * Math.sin(tiltX) * 1.5 - relX * Math.sin(tiltZ) * 1.5;
                const gravityForce = (targetHeight - h) * this.gravity;

                // 2. ANGULAR INERTIA: Angular acceleration causes sloshing
                // When cup accelerates its tilt, liquid resists (sloshes opposite)
                const angularInertiaForce = -relZ * clampedAccelX * 0.08 - relX * clampedAccelZ * 0.08;

                // 3. TRANSLATIONAL INERTIA: Moving the cup causes sloshing
                // When cup accelerates horizontally, liquid sloshes opposite to movement
                // Cup acceleration is in world space, convert effect to liquid surface
                const transInertiaForce = (
                    -relX * this.cupAcceleration.x * 0.6 +
                    -relZ * this.cupAcceleration.z * 0.6
                );

                // Apply forces
                vel += (gravityForce + angularInertiaForce + transInertiaForce) * 0.5;
                vel = Math.max(-this.maxVelocity, Math.min(this.maxVelocity, vel));
                this.setVelocity(gx, gy, vel);
            }
        }
    }

    updateWavePhysics(dt) {
        const c = this.waveSpeed * dt;
        const c2 = c * c;

        // Create new heights array for double-buffering
        const newHeights = [...this.heights];

        for (let gy = 1; gy < this.gridSize - 1; gy++) {
            for (let gx = 1; gx < this.gridSize - 1; gx++) {
                // Process all interior cells for uniform wave propagation

                // Wave equation: acceleration based on neighbor height differences
                const h = this.getHeight(gx, gy);
                const hLeft = this.getHeight(gx - 1, gy);
                const hRight = this.getHeight(gx + 1, gy);
                const hUp = this.getHeight(gx, gy - 1);
                const hDown = this.getHeight(gx, gy + 1);

                // Laplacian for wave propagation
                const laplacian = (hLeft + hRight + hUp + hDown) / 4 - h;

                // Update velocity
                let vel = this.getVelocity(gx, gy);
                vel += laplacian * c2 * 50;
                vel *= this.damping;

                // Clamp velocity
                vel = Math.max(-this.maxVelocity, Math.min(this.maxVelocity, vel));

                // Kill tiny oscillations - snap to zero when both velocity and height are small
                if (Math.abs(vel) < this.velocityThreshold && Math.abs(h) < this.velocityThreshold) {
                    vel = 0;
                }

                // Update height and clamp
                let newH = h + vel * dt;
                newH = Math.max(-this.maxHeight, Math.min(this.maxHeight, newH));

                // Also snap height to zero if very small
                if (Math.abs(newH) < this.velocityThreshold * 0.5 && Math.abs(vel) < this.velocityThreshold) {
                    newH = 0;
                }

                this.setVelocity(gx, gy, vel);
                newHeights[gy * this.gridSize + gx] = newH;
            }
        }

        this.heights = newHeights;
    }

    checkSpills(cupWorldPos, cupTilt) {
        // Check rim points for spills
        const rimPoints = 16;

        // Dynamic spill threshold: lower liquid = harder to spill
        // At full (0.9), threshold is 0.2. At empty (0), threshold is 0.6
        const levelRatio = this.liquidLevel / this.maxLiquidLevel;
        const dynamicThreshold = this.spillThreshold + (1 - levelRatio) * 0.4;

        for (let i = 0; i < rimPoints; i++) {
            const angle = (i / rimPoints) * Math.PI * 2;
            const rimX = Math.cos(angle) * this.cupRadius * 0.9;
            const rimZ = Math.sin(angle) * this.cupRadius * 0.9;

            // Find nearest grid point
            const gx = Math.round((rimX / this.cupRadius / 2 + 0.5) * (this.gridSize - 1));
            const gy = Math.round((rimZ / this.cupRadius / 2 + 0.5) * (this.gridSize - 1));

            if (gx < 0 || gx >= this.gridSize || gy < 0 || gy >= this.gridSize) continue;

            const height = this.getHeight(gx, gy);

            // Check if liquid is over rim
            // Tilt affects effective rim height at each point
            const effectiveRimHeight = dynamicThreshold - Math.sin(angle) * Math.sin(cupTilt) * 0.03;

            if (height > effectiveRimHeight) {
                // Spawn droplet
                this.spawnDroplet(cupWorldPos, rimX, rimZ, cupTilt);
                this.totalSpilled += 0.001;
                // Reduce liquid level as it spills
                this.liquidLevel = Math.max(0, this.liquidLevel - 0.002);
            }
        }
    }

    spawnDroplet(cupWorldPos, localX, localZ, cupTilt) {
        if (!this.physicsWorld) return;

        // Remove oldest if at max
        if (this.dropletBodies.length >= this.maxDroplets) {
            const oldest = this.dropletBodies.shift();
            this.physicsWorld.removeBody(oldest.body);
        }

        // Convert local position to world position using cup's transform
        // liquidMesh is already at liquidLevel, so use y=0 for the surface
        const localPos = new THREE.Vector3(localX, 0, localZ);
        const spillPos = new THREE.Vector3();
        this.liquidMesh.localToWorld(spillPos.copy(localPos));

        // Calculate outward direction from cup center
        const cupCenter = new THREE.Vector3();
        this.cup.getWorldPosition(cupCenter);
        const outwardDir = new THREE.Vector3()
            .subVectors(spillPos, cupCenter)
            .setY(0)
            .normalize();

        // Create cannon-es physics body
        const body = new CANNON.Body({
            mass: 0.001, // Small mass for droplet
            shape: this.dropletShape,
            position: new CANNON.Vec3(spillPos.x, spillPos.y, spillPos.z),
            linearDamping: 0.1,
            material: new CANNON.Material({ friction: 0.3, restitution: 0.2 })
        });

        // Inherit cup velocity + outward push
        body.velocity.set(
            this.cupVelocity.x + outwardDir.x * 0.3 + (Math.random() - 0.5) * 0.1,
            this.cupVelocity.y + (Math.random() - 0.5) * 0.1,
            this.cupVelocity.z + outwardDir.z * 0.3 + (Math.random() - 0.5) * 0.1
        );

        this.physicsWorld.addBody(body);
        this.dropletBodies.push({
            body: body,
            lifetime: 2.0, // Remove after 2 seconds max
            wasFalling: false,
            stained: false
        });
    }

    updateDroplets(deltaTime) {
        const groundHeight = 0.0; // Ground level

        // Update lifetimes and remove expired droplets
        for (let i = this.dropletBodies.length - 1; i >= 0; i--) {
            const d = this.dropletBodies[i];
            d.lifetime -= deltaTime;

            const pos = d.body.position;
            const vel = d.body.velocity;
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);

            // Check if droplet hit something:
            // - Was falling (had negative Y velocity) but now stopped or bouncing up
            // - Or speed is very low after initial drop
            const hitSomething = (d.wasFalling && vel.y >= -0.05) || (speed < 0.3 && d.lifetime < 1.8);

            // Track if droplet was falling
            if (vel.y < -0.5) d.wasFalling = true;

            if (hitSomething && !d.stained && d.wasFalling) {
                d.stained = true;
                // Use the actual Y position where the droplet stopped
                this.createStain(pos.x, pos.y + 0.001, pos.z);
                // Remove droplet immediately on contact
                this.physicsWorld.removeBody(d.body);
                this.dropletBodies.splice(i, 1);
                continue;
            }

            // Check if droplet hit ground level
            if (pos.y <= groundHeight + 0.02 && !d.stained) {
                d.stained = true;
                this.createStain(pos.x, groundHeight + 0.001, pos.z);
                // Remove droplet immediately on contact
                this.physicsWorld.removeBody(d.body);
                this.dropletBodies.splice(i, 1);
                continue;
            }

            // Remove if expired - create stain at current position
            if (d.lifetime <= 0) {
                if (!d.stained) {
                    this.createStain(pos.x, pos.y + 0.001, pos.z);
                }
                this.physicsWorld.removeBody(d.body);
                this.dropletBodies.splice(i, 1);
            }
        }

        // Render droplets as elongated ellipses based on velocity
        const dummy = new THREE.Object3D();
        this.dropletInstancedMesh.count = this.dropletBodies.length;

        for (let i = 0; i < this.dropletBodies.length; i++) {
            const d = this.dropletBodies[i];
            const body = d.body;
            const vel = body.velocity;

            dummy.position.set(body.position.x, body.position.y, body.position.z);

            // Calculate speed for elongation factor
            const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
            const elongation = 1 + Math.min(speed * 2, 3); // 1x to 4x stretch based on speed

            // Calculate 3D velocity direction and orient droplet
            // Use lookAt approach: create a target point in velocity direction
            if (speed > 0.1) {
                const targetPos = new THREE.Vector3(
                    body.position.x + vel.x,
                    body.position.y + vel.y,
                    body.position.z + vel.z
                );
                dummy.lookAt(targetPos);
                // Scale: elongate along Z (forward direction after lookAt), keep X/Y normal
                dummy.scale.set(1, 1, elongation);
            } else {
                dummy.rotation.set(-Math.PI / 2, 0, 0); // Flat horizontal when slow
                dummy.scale.setScalar(1);
            }

            dummy.updateMatrix();
            this.dropletInstancedMesh.setMatrixAt(i, dummy.matrix);
        }

        this.dropletInstancedMesh.instanceMatrix.needsUpdate = true;
    }

    calculateAverageTextureColor(texturePath, callback) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            // Sample at small size for performance
            const sampleSize = 64;
            canvas.width = sampleSize;
            canvas.height = sampleSize;
            ctx.drawImage(img, 0, 0, sampleSize, sampleSize);

            const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
            const data = imageData.data;

            let r = 0, g = 0, b = 0;
            const pixelCount = data.length / 4;

            for (let i = 0; i < data.length; i += 4) {
                r += data[i];
                g += data[i + 1];
                b += data[i + 2];
            }

            callback({
                r: (r / pixelCount) / 255,
                g: (g / pixelCount) / 255,
                b: (b / pixelCount) / 255
            });
        };
        img.src = texturePath;
    }

    /**
     * Create organic ellipse geometry with noise-distorted edges
     */
    createOrganicEllipseGeometry(radiusX, radiusY, segments = 32) {
        const shape = new THREE.Shape();

        // Random phase offsets for variety
        const phase1 = Math.random() * Math.PI * 2;
        const phase2 = Math.random() * Math.PI * 2;
        const phase3 = Math.random() * Math.PI * 2;

        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;

            // Low frequency, high amplitude for smooth organic blobs
            const noise1 = Math.sin(angle * 1 + phase1) * 0.35;  // 1 lobe
            const noise2 = Math.sin(angle * 2 + phase2) * 0.25;  // 2 lobes
            const noise3 = Math.sin(angle * 3 + phase3) * 0.15;  // 3 lobes
            const noiseScale = 1 + noise1 + noise2 + noise3;

            const px = Math.cos(angle) * radiusX * noiseScale;
            const py = Math.sin(angle) * radiusY * noiseScale;

            if (i === 0) {
                shape.moveTo(px, py);
            } else {
                shape.lineTo(px, py);
            }
        }

        const geometry = new THREE.ShapeGeometry(shape);

        // Generate UVs based on position (for shader)
        const pos = geometry.attributes.position;
        const uvs = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
            // Map position to 0-1 UV range
            uvs[i * 2] = (pos.getX(i) / radiusX + 1) * 0.5;
            uvs[i * 2 + 1] = (pos.getY(i) / radiusY + 1) * 0.5;
        }
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        return geometry;
    }

    createStain(x, y, z) {
        // Skip stains on top of the ashtray
        const ashtrayX = 0.26, ashtrayZ = -0.25, ashtrayRadius = 0.08;
        const distToAshtray = Math.sqrt((x - ashtrayX) ** 2 + (z - ashtrayZ) ** 2);
        if (y > 0.5 && distToAshtray < ashtrayRadius) {
            return; // Don't stain on ashtray
        }

        // Remove oldest stain if at max
        if (this.stains.length >= this.maxStains) {
            const oldest = this.stains.shift();
            this.scene.remove(oldest.mesh);
            oldest.mesh.geometry.dispose();
            oldest.mesh.material.dispose();
        }

        // Snap stain Y to nearest surface (table at ~0.77, ground at 0)
        const tableHeight = 0.77;
        const groundHeight = 0.001;
        let stainY;
        if (y > 0.5) {
            stainY = tableHeight;
        } else {
            stainY = groundHeight;
        }

        // Random ellipse dimensions with large variation
        // Weighted random: mostly small, occasionally big splashes
        const sizeRoll = Math.random();
        let baseSize;
        if (sizeRoll < 0.6) {
            baseSize = 0.005 + Math.random() * 0.005; // Small (60%)
        } else if (sizeRoll < 0.85) {
            baseSize = 0.01 + Math.random() * 0.008; // Medium (25%)
        } else {
            baseSize = 0.015 + Math.random() * 0.015; // Large - up to 3x (15%)
        }
        const aspectRatio = 0.5 + Math.random() * 1.0; // 0.5 to 1.5 for more elongation
        const radiusX = baseSize;
        const radiusY = baseSize * aspectRatio;

        // Create organic ellipse geometry
        const geometry = this.createOrganicEllipseGeometry(radiusX, radiusY);

        // Create material with color variation (coffee browns)
        const baseColor = new THREE.Color(0x8b6914);
        const colorVariation = (Math.random() - 0.5) * 0.1;
        const stainColor = new THREE.Color(
            Math.max(0.2, baseColor.r + colorVariation),
            Math.max(0.1, baseColor.g + colorVariation * 0.8),
            Math.max(0, baseColor.b + colorVariation * 0.5)
        );

        const stainMat = this.stainMaterial.clone();
        stainMat.uniforms = {
            uColor: { value: stainColor },
            uOpacity: { value: 0.35 + Math.random() * 0.15 },
            uDryness: { value: 0.0 } // Starts fresh, dries over time
        };

        const stain = new THREE.Mesh(geometry, stainMat);
        stain.position.set(x, stainY, z);
        stain.rotation.x = -Math.PI / 2; // Flat on surface
        stain.rotation.z = Math.random() * Math.PI * 2; // Random rotation
        stain.scale.setScalar(0.8 + Math.random() * 0.5);
        this.scene.add(stain);
        this.stains.push({ mesh: stain, age: 0 }); // Track age for drying effect
    }

    updateStains(deltaTime) {
        const dryTime = 5.0; // Seconds to fully dry and form coffee ring
        for (const stain of this.stains) {
            if (stain.age < dryTime) {
                stain.age += deltaTime;
                const dryness = Math.min(1.0, stain.age / dryTime);
                if (stain.mesh.material.uniforms && stain.mesh.material.uniforms.uDryness) {
                    stain.mesh.material.uniforms.uDryness.value = dryness;
                }
            }
        }
    }

    updateLiquidMesh(cupWorldPos, cupTilt) {
        // Position liquid mesh relative to cup (local coordinates)
        // Since liquid is a child of cup, just set Y offset for liquid level
        this.liquidMesh.position.set(0, this.liquidLevel, 0);

        // Scale the cylinder body based on liquid level (so it shrinks, not just lowers)
        const levelRatio = this.liquidLevel / this.maxLiquidLevel;
        this.bodyMesh.scale.y = levelRatio;
        // Adjust position so top stays at surface while bottom rises
        this.bodyMesh.position.y = -0.75 * levelRatio; // Half of original bodyHeight (1.5) * ratio

        // Update vertex positions based on heightfield (top surface only)
        const positions = this.topGeometry.attributes.position.array;

        // Iterate through vertex map to update each vertex
        for (const [key, vertexIdx] of Object.entries(this.vertexMap)) {
            const [gx, gy] = key.split(',').map(Number);

            const ox = this.originalPositions[vertexIdx * 3];
            const oy = this.originalPositions[vertexIdx * 3 + 1];
            const oz = this.originalPositions[vertexIdx * 3 + 2];

            // Get height from simulation
            const heightOffset = this.getHeight(gx, gy);

            positions[vertexIdx * 3] = ox;
            positions[vertexIdx * 3 + 1] = oy + heightOffset;
            positions[vertexIdx * 3 + 2] = oz;
        }

        this.topGeometry.attributes.position.needsUpdate = true;
        this.topGeometry.computeVertexNormals();
    }

    /**
     * Spill all remaining liquid at once (e.g., when cup breaks)
     * @param {THREE.Vector3} impactPoint - Where the cup broke
     */
    spillAll(impactPoint) {
        if (this.liquidLevel <= 0) return;

        // Get cup world position
        const cupWorldPos = new THREE.Vector3();
        this.cup.getWorldPosition(cupWorldPos);

        // Number of droplets based on how much liquid was left (much more now!)
        const dropletCount = Math.floor(this.liquidLevel / this.maxLiquidLevel * 120);

        // Spawn droplets across the liquid surface
        for (let i = 0; i < dropletCount; i++) {
            // Random position on liquid surface
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.random() * this.cupRadius * 0.8;
            const localX = Math.cos(angle) * radius;
            const localZ = Math.sin(angle) * radius;

            // Spawn at impact point with outward velocity
            const localPos = new THREE.Vector3(localX, 0, localZ);
            const spillPos = new THREE.Vector3();
            if (this.liquidMesh && this.liquidMesh.parent) {
                this.liquidMesh.localToWorld(spillPos.copy(localPos));
            } else {
                // Fallback if liquidMesh was already removed
                spillPos.copy(impactPoint).add(new THREE.Vector3(localX * 0.04, 0, localZ * 0.04));
            }

            // Create cannon-es physics body
            const body = new CANNON.Body({
                mass: 0.001,
                shape: this.dropletShape,
                position: new CANNON.Vec3(spillPos.x, spillPos.y, spillPos.z),
                linearDamping: 0.1,
                material: new CANNON.Material({ friction: 0.3, restitution: 0.2 })
            });

            // Outward explosion velocity from impact point - more splashy!
            const outwardDir = new THREE.Vector3()
                .subVectors(spillPos, impactPoint)
                .normalize();

            const speed = 1.0 + Math.random() * 2.5; // Faster spread
            body.velocity.set(
                outwardDir.x * speed + (Math.random() - 0.5) * 1.0,
                Math.random() * 1.5, // More upward splash
                outwardDir.z * speed + (Math.random() - 0.5) * 1.0
            );

            this.physicsWorld.addBody(body);
            this.dropletBodies.push({
                body: body,
                lifetime: 4.0, // Longer lifetime to travel further
                wasFalling: false,
                stained: false
            });
        }

        // Empty the cup
        this.liquidLevel = 0;
    }

    // Get how much has been spilled (for scoring/feedback)
    getTotalSpilled() {
        return this.totalSpilled;
    }

    // Get current liquid level percentage
    getLiquidPercentage() {
        return this.liquidLevel / this.maxLiquidLevel;
    }

    dispose() {
        this.cup.remove(this.liquidMesh);
        this.topGeometry.dispose();
        this.liquidMaterial.dispose();
        this.coffeeTexture.dispose();
        this.distortionTexture.dispose();

        // Clean up physics droplets
        for (const d of this.dropletBodies) {
            this.physicsWorld.removeBody(d.body);
        }
        this.dropletBodies = [];

        // Clean up instanced mesh
        this.scene.remove(this.dropletInstancedMesh);
        this.dropletInstancedMesh.geometry.dispose();
        this.dropletInstancedMesh.material.dispose();

        // Clean up stains (each has its own geometry now)
        for (const s of this.stains) {
            this.scene.remove(s.mesh);
            s.mesh.geometry.dispose();
            s.mesh.material.dispose();
        }
        this.stains = [];
        this.stainMaterial.dispose();
    }
}
