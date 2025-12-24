import * as THREE from 'three';

// Animation states
export const AnimationState = {
    IDLE: 'idle',
    DRINKING: 'drinking',
    SMOKING: 'smoking'
};

export class AnimationController {
    constructor(hands, particleSystem) {
        this.hands = hands;
        this.particles = particleSystem;
        this.state = AnimationState.IDLE;
        this.animationProgress = 0;
        this.animationDuration = 2.0; // seconds

        this.exhaleTriggered = false;
    }

    isAnimating() {
        return this.state !== AnimationState.IDLE;
    }

    startDrink() {
        if (this.isAnimating()) return false;
        this.state = AnimationState.DRINKING;
        this.animationProgress = 0;
        this.animationDuration = 2.5;
        return true;
    }

    startSmoke() {
        if (this.isAnimating()) return false;
        this.state = AnimationState.SMOKING;
        this.animationProgress = 0;
        this.animationDuration = 3.0;
        this.exhaleTriggered = false;
        return true;
    }

    update(deltaTime) {
        if (this.state === AnimationState.IDLE) return;

        this.animationProgress += deltaTime / this.animationDuration;

        if (this.animationProgress >= 1) {
            this.animationProgress = 1;
            this.finishAnimation();
            return;
        }

        const t = this.animationProgress;

        if (this.state === AnimationState.DRINKING) {
            this.updateDrinkAnimation(t);
        } else if (this.state === AnimationState.SMOKING) {
            this.updateSmokeAnimation(t);
        }
    }

    updateDrinkAnimation(t) {
        // Animation curve: go up, hold, come back
        let progress, tilt;

        if (t < 0.3) {
            // Lift cup to mouth
            progress = this.easeOutCubic(t / 0.3);
            tilt = 0;
        } else if (t < 0.7) {
            // At mouth, tilt to drink
            progress = 1;
            const drinkT = (t - 0.3) / 0.4;
            tilt = Math.sin(drinkT * Math.PI) * 0.7; // Tilt up to 0.7 rad
        } else {
            // Return to table
            progress = 1 - this.easeInCubic((t - 0.7) / 0.3);
            tilt = 0;
        }

        this.hands.cupAnimationProgress = progress;
        this.hands.cupTilt = tilt;
    }

    updateSmokeAnimation(t) {
        // Animation curve: go up, hold (inhale), come back, exhale
        let progress;

        if (t < 0.25) {
            // Lift cigarette to mouth
            progress = this.easeOutCubic(t / 0.25);
        } else if (t < 0.55) {
            // At mouth (inhaling)
            progress = 1;
        } else if (t < 0.75) {
            // Lower cigarette
            progress = 1 - this.easeInCubic((t - 0.55) / 0.2);
        } else {
            // Back on table
            progress = 0;
        }

        this.hands.cigaretteAnimationProgress = progress;

        // Trigger exhale smoke
        if (t > 0.65 && !this.exhaleTriggered) {
            this.exhaleTriggered = true;
            if (this.particles) {
                this.particles.triggerExhale();
            }
        }
    }

    easeOutCubic(t) {
        return 1 - Math.pow(1 - t, 3);
    }

    easeInCubic(t) {
        return t * t * t;
    }

    easeInOutCubic(t) {
        return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    finishAnimation() {
        this.state = AnimationState.IDLE;
        this.hands.resetPositions();
    }
}
