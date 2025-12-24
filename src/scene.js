import * as THREE from 'three';

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
