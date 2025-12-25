import * as THREE from 'three';
import {
    loadModelWithFallback,
    createFallbackHand,
    createFallbackCup,
    createFallbackCigarette
} from './loader.js';

export class Hands {
    constructor(camera, scene) {
        this.camera = camera;
        this.scene = scene;
        this.group = new THREE.Group(); // Keep for compatibility but won't use for items

        // Items
        this.coffeeCup = null;
        this.cigarette = null;

        // Table rest positions (world space) - rotated 30° right to match table
        this.cupTablePosition = new THREE.Vector3(0.34, 0.85, -0.09);
        this.cigaretteTablePosition = new THREE.Vector3(0.22, 0.76, -0.19); // On edge of ashtray rim

        // Animation state
        this.cupAnimationProgress = 0; // 0 = on table, 1 = at mouth
        this.cigaretteAnimationProgress = 0;
        this.cupTilt = 0;
        this.cigaretteRotation = 0; // Extra rotation when bringing to mouth

        // Cigarette burn state (1.0 = full, 0 = fully burned)
        this.cigaretteBurnLevel = 1.0;
        this.cigaretteOriginalScale = 0.8; // Original scale from init

        // Physics control flags
        this.cupPhysicsControlled = false;
        this.cigarettePhysicsControlled = false;
    }

    async init() {
        this.group.name = 'hands-container';

        // Load coffee cup - add to scene (world space)
        this.coffeeCup = await loadModelWithFallback(
            'models/coffee_cup.glb',
            createFallbackCup,
            { scale: 0.04 }
        );
        this.coffeeCup.name = 'coffee-cup';
        this.scene.add(this.coffeeCup);
        this.coffeeCup.position.copy(this.cupTablePosition);
        this.coffeeCup.rotation.y = Math.PI + Math.PI / 6; // 210° yaw (30° CCW from 180°)

        // Load cigarette - add to scene (world space)
        this.cigarette = createFallbackCigarette();
        this.cigarette.scale.setScalar(0.8);
        this.cigarette.name = 'cigarette';
        this.scene.add(this.cigarette);
        this.cigarette.position.copy(this.cigaretteTablePosition);
        this.cigarette.rotation.set(0, Math.PI / 2, 0.2); // Rotate 90° right

        return this.group;
    }

    /**
     * Get the mouth position in world space based on camera
     */
    getMouthWorldPosition() {
        const mouthOffset = new THREE.Vector3(0, -0.08, -0.25);
        const worldPos = mouthOffset.clone();
        this.camera.localToWorld(worldPos);
        return worldPos;
    }

    /**
     * Update item positions based on animation progress
     * Skip updates if physics is controlling the object
     */
    update() {
        // Update coffee cup position (only if not physics controlled or animating)
        if (this.coffeeCup && (!this.cupPhysicsControlled || this.cupAnimationProgress > 0)) {
            const mouthPos = this.getMouthWorldPosition();
            // Lerp between table and mouth
            this.coffeeCup.position.lerpVectors(
                this.cupTablePosition,
                mouthPos,
                this.cupAnimationProgress
            );
            // Tilt cup when drinking
            this.coffeeCup.rotation.x = this.cupTilt;
            // Rotate cup to face camera when lifted
            if (this.cupAnimationProgress > 0.1) {
                const lookDir = new THREE.Vector3();
                this.camera.getWorldDirection(lookDir);
                this.coffeeCup.rotation.y = Math.atan2(lookDir.x, lookDir.z) + Math.PI;
            }
        }

        // Only apply cup rotation when actively tilting (being grabbed near mouth)
        // Otherwise let physics control the rotation
        if (this.coffeeCup && this.cupPhysicsControlled && this.cupTilt > 0) {
            this.coffeeCup.rotation.set(0, Math.PI + Math.PI / 6, -this.cupTilt); // 30° counterclockwise
        }

        // Update cigarette position (only if not physics controlled or animating)
        if (this.cigarette && (!this.cigarettePhysicsControlled || this.cigaretteAnimationProgress > 0)) {
            const mouthPos = this.getMouthWorldPosition();
            // Offset cigarette slightly to the side of mouth
            const cigMouthPos = mouthPos.clone();
            cigMouthPos.x -= 0.05;

            // Lerp between table and mouth
            this.cigarette.position.lerpVectors(
                this.cigaretteTablePosition,
                cigMouthPos,
                this.cigaretteAnimationProgress
            );
            // Rotate cigarette when lifted
            if (this.cigaretteAnimationProgress > 0.1) {
                const lookDir = new THREE.Vector3();
                this.camera.getWorldDirection(lookDir);
                this.cigarette.rotation.y = Math.atan2(lookDir.x, lookDir.z) - Math.PI / 2;
                this.cigarette.rotation.z = 0.2 + this.cigaretteAnimationProgress * 0.3;
            } else if (!this.cigarettePhysicsControlled) {
                this.cigarette.rotation.set(0, Math.PI / 2, 0.2); // Keep rotated on table
            }
        }

        // Only apply cigarette rotation when actively rotating (being grabbed near mouth)
        // Otherwise let physics control the rotation
        if (this.cigarette && this.cigarettePhysicsControlled && this.cigaretteRotation > 0) {
            // Rotate yaw clockwise as it approaches mouth
            this.cigarette.rotation.set(0, Math.PI / 2 - this.cigaretteRotation, 0.2);
        }
    }

    /**
     * Set whether physics controls the cup
     */
    setCupPhysicsControlled(controlled) {
        this.cupPhysicsControlled = controlled;
    }

    /**
     * Set whether physics controls the cigarette
     */
    setCigarettePhysicsControlled(controlled) {
        this.cigarettePhysicsControlled = controlled;
    }

    /**
     * Reset items to table positions
     */
    resetPositions() {
        this.cupAnimationProgress = 0;
        this.cigaretteAnimationProgress = 0;
        this.cupTilt = 0;

        if (this.coffeeCup) {
            this.coffeeCup.position.copy(this.cupTablePosition);
            this.coffeeCup.rotation.set(0, Math.PI + Math.PI / 6, 0); // Keep 210° yaw
        }
        if (this.cigarette) {
            this.cigarette.position.copy(this.cigaretteTablePosition);
            this.cigarette.rotation.set(0, Math.PI / 2, 0.2);
        }
    }

    /**
     * Get the world position of the cigarette tip for particles
     */
    getCigaretteTipWorldPosition() {
        if (!this.cigarette) return new THREE.Vector3();

        // Tip position
        const tipOffset = new THREE.Vector3(0.034, 0, 0);
        const worldPos = new THREE.Vector3();
        this.cigarette.localToWorld(worldPos.copy(tipOffset));
        return worldPos;
    }

    /**
     * Get the world position of the coffee cup top for steam
     */
    getCoffeeCupWorldPosition() {
        if (!this.coffeeCup) return new THREE.Vector3();

        const topOffset = new THREE.Vector3(0, 2.5, 0); // In local space (before 0.04 scale)
        const worldPos = new THREE.Vector3();
        this.coffeeCup.localToWorld(worldPos.copy(topOffset));
        return worldPos;
    }

    getCoffeeCup() { return this.coffeeCup; }
    getCigarette() { return this.cigarette; }

    /**
     * Burn the cigarette (reduce its length)
     * Shrinks paper and moves tip, but filter stays the same
     * @param amount - how much to burn (0.1 = 10% of original length)
     */
    burnCigarette(amount = 0.1) {
        this.cigaretteBurnLevel = Math.max(0.2, this.cigaretteBurnLevel - amount);
        if (this.cigarette) {
            const paper = this.cigarette.getObjectByName('paper');
            const tip = this.cigarette.getObjectByName('tip');

            if (paper && tip) {
                // Cylinder length is along Y axis (before rotation), so scale Y only
                // Keep X and Z at 1 to preserve width/radius
                paper.scale.set(1, this.cigaretteBurnLevel, 1);

                // Original paper length and positions
                const originalLength = this.cigarette.userData.originalPaperLength || 0.06;
                const newLength = originalLength * this.cigaretteBurnLevel;

                // Move paper toward filter as it shrinks (paper center moves left)
                const shrinkAmount = (originalLength - newLength) / 2;
                paper.position.x = -shrinkAmount;

                // Move tip to stay at end of shortened paper
                const originalTipX = this.cigarette.userData.originalTipX || 0.03;
                tip.position.x = originalTipX - (originalLength - newLength);
            }
        }
    }

    /**
     * Get current cigarette burn level (1.0 = full, 0.2 = almost gone)
     */
    getCigaretteBurnLevel() {
        return this.cigaretteBurnLevel;
    }

    /**
     * Set cigarette tip size (for smoking effect)
     * @param intensity - 0 = default size, grows with smoking
     */
    setTipGlow(intensity) {
        if (!this.cigarette) return;
        const tip = this.cigarette.getObjectByName('tip');
        if (tip) {
            // Scale tip length - grows significantly with intensity
            // Cylinder height is Y in local space (before rotation), so scale Y
            tip.scale.y = 1 + intensity * 20;

            // Make tip glow brighter with intensity
            if (tip.material) {
                tip.material.emissiveIntensity = 1.5 + intensity * 10;
            }
        }
    }

    /**
     * Get current tip glow intensity
     */
    getTipGlow() {
        if (!this.cigarette) return 0;
        const tip = this.cigarette.getObjectByName('tip');
        if (tip && tip.material) {
            return (tip.material.emissiveIntensity - 1.5) / 8.5;
        }
        return 0;
    }
}
