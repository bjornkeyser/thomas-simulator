import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

export function createScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Light sky blue (fallback)
    // Remove fog when using panorama background
    return scene;
}

/**
 * Load an equirectangular panorama image as the scene background
 * @param {THREE.Scene} scene
 * @param {string} imagePath - Path to equirectangular image (2:1 ratio)
 * @returns {Promise<THREE.Texture>}
 */
export function loadPanoramaBackground(scene, imagePath) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.TextureLoader();
        loader.load(
            imagePath,
            (texture) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                texture.colorSpace = THREE.SRGBColorSpace;
                scene.background = texture;
                scene.environment = texture; // Also use for reflections
                console.log('Panorama background loaded:', imagePath);
                resolve(texture);
            },
            undefined,
            (error) => {
                console.warn('Failed to load panorama, using fallback color:', error);
                reject(error);
            }
        );
    });
}

export function createCamera() {
    const camera = new THREE.PerspectiveCamera(
        60, // FOV - slightly narrow for seated feeling
        window.innerWidth / window.innerHeight,
        0.1,
        1000
    );

    // Seated position at a cafe table
    // Y is sitting eye height (~1.1m), looking slightly down
    camera.position.set(0, 1.1, 0);
    camera.rotation.x = -0.1; // Slight downward tilt

    return camera;
}

export function createRenderer(canvas) {
    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true
    });

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    return renderer;
}

export function createLighting(scene) {
    // Ambient light for base illumination
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);

    // Main directional light (sunlight from window)
    const sunlight = new THREE.DirectionalLight(0xfffaf0, 1.2);
    sunlight.position.set(5, 8, 3);
    sunlight.castShadow = true;
    sunlight.shadow.mapSize.width = 2048;
    sunlight.shadow.mapSize.height = 2048;
    sunlight.shadow.camera.near = 0.5;
    sunlight.shadow.camera.far = 50;
    sunlight.shadow.camera.left = -10;
    sunlight.shadow.camera.right = 10;
    sunlight.shadow.camera.top = 10;
    sunlight.shadow.camera.bottom = -10;
    scene.add(sunlight);

    // Fill light from opposite side
    const fillLight = new THREE.DirectionalLight(0xaaccff, 0.3);
    fillLight.position.set(-3, 4, -2);
    scene.add(fillLight);

    return { ambient, sunlight, fillLight };
}

export function createFloor(scene) {
    // Simple floor as fallback/base
    const floorGeometry = new THREE.PlaneGeometry(20, 20);
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x8B7355, // Cafe floor brown
        roughness: 0.8,
        metalness: 0.1
    });

    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    return floor;
}

export function handleResize(camera, renderer) {
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

/**
 * Create a sun with classic lens flare effect
 * @param {THREE.Scene} scene
 * @returns {THREE.PointLight} The sun light
 */
export function createSunWithLensflare(scene) {
    // Create sun as a point light
    const sunLight = new THREE.PointLight(0xffffee, 3, 0, 0);
    sunLight.position.set(50, 80, -100); // High in the sky, slightly behind/left

    // Create lens flare textures procedurally
    const textureLoader = new THREE.TextureLoader();

    // Create procedural flare textures
    const flareTexture = createFlareTexture(256, 0xffffff);
    const flareHexTexture = createHexFlareTexture(128, 0xffffaa);
    const flareRingTexture = createRingFlareTexture(128, 0xffaa44);

    // Create lensflare with multiple elements
    const lensflare = new Lensflare();

    // Main sun glow
    lensflare.addElement(new LensflareElement(flareTexture, 700, 0, new THREE.Color(0xffffee)));

    // Secondary flare elements (hexagonal reflections)
    lensflare.addElement(new LensflareElement(flareHexTexture, 60, 0.2, new THREE.Color(0xffeeaa)));
    lensflare.addElement(new LensflareElement(flareHexTexture, 80, 0.3, new THREE.Color(0xffddaa)));
    lensflare.addElement(new LensflareElement(flareRingTexture, 120, 0.4, new THREE.Color(0xffaa66)));
    lensflare.addElement(new LensflareElement(flareHexTexture, 40, 0.5, new THREE.Color(0xffcc88)));
    lensflare.addElement(new LensflareElement(flareRingTexture, 90, 0.6, new THREE.Color(0xff8844)));
    lensflare.addElement(new LensflareElement(flareHexTexture, 50, 0.7, new THREE.Color(0xffbb77)));
    lensflare.addElement(new LensflareElement(flareTexture, 200, 0.9, new THREE.Color(0xffaa44)));
    lensflare.addElement(new LensflareElement(flareHexTexture, 30, 1.0, new THREE.Color(0xffcc66)));

    sunLight.add(lensflare);
    scene.add(sunLight);

    console.log('Sun with lens flare created');
    return sunLight;
}

/**
 * Create a circular gradient flare texture
 */
function createFlareTexture(size, color) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createRadialGradient(
        size / 2, size / 2, 0,
        size / 2, size / 2, size / 2
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(255, 255, 200, 0.8)');
    gradient.addColorStop(0.4, 'rgba(255, 200, 100, 0.4)');
    gradient.addColorStop(1, 'rgba(255, 150, 50, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

/**
 * Create a hexagonal flare texture (classic lens artifact)
 */
function createHexFlareTexture(size, color) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, size, size);

    const centerX = size / 2;
    const centerY = size / 2;
    const radius = size * 0.4;

    // Draw hexagon
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI * 2) / 6 - Math.PI / 2;
        const x = centerX + radius * Math.cos(angle);
        const y = centerY + radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Gradient fill
    const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
    gradient.addColorStop(0, 'rgba(255, 255, 200, 0.6)');
    gradient.addColorStop(0.5, 'rgba(255, 200, 100, 0.3)');
    gradient.addColorStop(1, 'rgba(255, 150, 50, 0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}

/**
 * Create a ring flare texture
 */
function createRingFlareTexture(size, color) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const centerX = size / 2;
    const centerY = size / 2;
    const outerRadius = size * 0.45;
    const innerRadius = size * 0.3;

    // Outer gradient
    const gradient = ctx.createRadialGradient(
        centerX, centerY, innerRadius,
        centerX, centerY, outerRadius
    );
    gradient.addColorStop(0, 'rgba(255, 200, 100, 0)');
    gradient.addColorStop(0.3, 'rgba(255, 180, 80, 0.4)');
    gradient.addColorStop(0.7, 'rgba(255, 150, 50, 0.3)');
    gradient.addColorStop(1, 'rgba(255, 100, 0, 0)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    return texture;
}
