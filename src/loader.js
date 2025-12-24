import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltfLoader = new GLTFLoader();

// Cache for loaded models
const modelCache = new Map();

/**
 * Load a GLTF/GLB model
 * @param {string} path - Path to the model file
 * @param {Object} options - Optional settings
 * @returns {Promise<THREE.Group>} The loaded model
 */
export async function loadModel(path, options = {}) {
    const {
        position = { x: 0, y: 0, z: 0 },
        scale = 1,
        rotation = { x: 0, y: 0, z: 0 },
        castShadow = true,
        receiveShadow = true
    } = options;

    // Check cache first
    if (modelCache.has(path)) {
        const cached = modelCache.get(path).clone();
        applyTransforms(cached, position, scale, rotation);
        return cached;
    }

    return new Promise((resolve, reject) => {
        gltfLoader.load(
            path,
            (gltf) => {
                const model = gltf.scene;

                // Enable shadows on all meshes
                model.traverse((child) => {
                    if (child.isMesh) {
                        child.castShadow = castShadow;
                        child.receiveShadow = receiveShadow;
                    }
                });

                // Cache the original
                modelCache.set(path, model.clone());

                // Apply transforms
                applyTransforms(model, position, scale, rotation);

                // Store animations if any
                if (gltf.animations && gltf.animations.length > 0) {
                    model.userData.animations = gltf.animations;
                }

                resolve(model);
            },
            (progress) => {
                // Progress callback
                const percent = (progress.loaded / progress.total * 100).toFixed(0);
                console.log(`Loading ${path}: ${percent}%`);
            },
            (error) => {
                console.error(`Failed to load model: ${path}`, error);
                reject(error);
            }
        );
    });
}

function applyTransforms(model, position, scale, rotation) {
    model.position.set(position.x, position.y, position.z);

    if (typeof scale === 'number') {
        model.scale.setScalar(scale);
    } else {
        model.scale.set(scale.x, scale.y, scale.z);
    }

    model.rotation.set(rotation.x, rotation.y, rotation.z);
}

/**
 * Create a fallback primitive shape when model fails to load
 */
export function createFallbackCube(color = 0xff0000, size = 0.2) {
    const geometry = new THREE.BoxGeometry(size, size, size);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    return mesh;
}

/**
 * Create fallback hand (simple box)
 */
export function createFallbackHand() {
    const group = new THREE.Group();

    // Palm
    const palmGeo = new THREE.BoxGeometry(0.08, 0.12, 0.03);
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffdbac });
    const palm = new THREE.Mesh(palmGeo, skinMat);
    palm.castShadow = true;
    group.add(palm);

    // Simple fingers
    for (let i = 0; i < 4; i++) {
        const fingerGeo = new THREE.BoxGeometry(0.015, 0.06, 0.015);
        const finger = new THREE.Mesh(fingerGeo, skinMat);
        finger.position.set(-0.025 + i * 0.018, 0.08, 0);
        finger.castShadow = true;
        group.add(finger);
    }

    // Thumb
    const thumbGeo = new THREE.BoxGeometry(0.02, 0.04, 0.015);
    const thumb = new THREE.Mesh(thumbGeo, skinMat);
    thumb.position.set(-0.05, 0.02, 0);
    thumb.rotation.z = 0.5;
    thumb.castShadow = true;
    group.add(thumb);

    return group;
}

/**
 * Create fallback coffee cup
 */
export function createFallbackCup() {
    const group = new THREE.Group();

    // Cup body (cylinder)
    const cupGeo = new THREE.CylinderGeometry(0.035, 0.03, 0.1, 16);
    const cupMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const cup = new THREE.Mesh(cupGeo, cupMat);
    cup.position.y = 0.05;
    cup.castShadow = true;
    group.add(cup);

    // Coffee inside
    const coffeeGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.02, 16);
    const coffeeMat = new THREE.MeshStandardMaterial({ color: 0x3d2314 });
    const coffee = new THREE.Mesh(coffeeGeo, coffeeMat);
    coffee.position.y = 0.09;
    group.add(coffee);

    // Handle
    const handleGeo = new THREE.TorusGeometry(0.02, 0.005, 8, 16, Math.PI);
    const handle = new THREE.Mesh(handleGeo, cupMat);
    handle.position.set(0.045, 0.05, 0);
    handle.rotation.y = Math.PI / 2;
    handle.rotation.z = Math.PI / 2;
    handle.castShadow = true;
    group.add(handle);

    return group;
}

/**
 * Create fallback cigarette
 */
export function createFallbackCigarette() {
    const group = new THREE.Group();

    // White paper part
    const paperGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.06, 8);
    const paperMat = new THREE.MeshStandardMaterial({ color: 0xfaf8f5 });
    const paper = new THREE.Mesh(paperGeo, paperMat);
    paper.name = 'paper';
    paper.rotation.z = Math.PI / 2;
    paper.castShadow = true;
    group.add(paper);

    // Filter (stays same size when burning)
    const filterGeo = new THREE.CylinderGeometry(0.004, 0.004, 0.015, 8);
    const filterMat = new THREE.MeshStandardMaterial({ color: 0xd4a574 });
    const filter = new THREE.Mesh(filterGeo, filterMat);
    filter.name = 'filter';
    filter.rotation.z = Math.PI / 2;
    filter.position.x = -0.0375;
    filter.castShadow = true;
    group.add(filter);

    // Burning tip - starts as thin disk, grows in depth when smoking
    // Base height is 0.001, will scale up to 0.01 (10x) when smoking
    const tipGeo = new THREE.CylinderGeometry(0.0035, 0.0035, 0.001, 12);
    const tipMat = new THREE.MeshStandardMaterial({
        color: 0xff4500,
        emissive: 0xff4400,
        emissiveIntensity: 1.5
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.name = 'tip';
    tip.rotation.z = Math.PI / 2;
    // Position flush with paper end
    tip.position.x = 0.03;
    group.add(tip);

    // Store original positions for burn calculation
    group.userData.originalPaperLength = 0.06;
    group.userData.originalTipX = 0.03;

    return group;
}

/**
 * Create fallback table
 */
export function createFallbackTable() {
    const group = new THREE.Group();

    // Table top
    const topGeo = new THREE.BoxGeometry(0.8, 0.03, 0.6);
    const woodMat = new THREE.MeshStandardMaterial({
        color: 0x8B4513,
        roughness: 0.7
    });
    const top = new THREE.Mesh(topGeo, woodMat);
    top.position.y = 0.75;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);

    // Legs
    const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.75, 8);
    const positions = [
        [-0.35, 0.375, -0.25],
        [0.35, 0.375, -0.25],
        [-0.35, 0.375, 0.25],
        [0.35, 0.375, 0.25]
    ];

    positions.forEach(pos => {
        const leg = new THREE.Mesh(legGeo, woodMat);
        leg.position.set(...pos);
        leg.castShadow = true;
        group.add(leg);
    });

    return group;
}

/**
 * Try to load a model, falling back to primitive if it fails
 */
export async function loadModelWithFallback(path, fallbackFn, options = {}) {
    try {
        return await loadModel(path, options);
    } catch (error) {
        console.warn(`Using fallback for ${path}`);
        const fallback = fallbackFn();
        applyTransforms(
            fallback,
            options.position || { x: 0, y: 0, z: 0 },
            options.scale || 1,
            options.rotation || { x: 0, y: 0, z: 0 }
        );
        return fallback;
    }
}
