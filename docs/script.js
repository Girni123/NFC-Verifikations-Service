document.addEventListener('DOMContentLoaded', () => {
    console.log('NFC Verification Service loaded.');

    const verifyBtn = document.querySelector('.btn.primary');
    
    if (verifyBtn) {
        verifyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Simulate scan
            const originalText = verifyBtn.textContent;
            verifyBtn.textContent = 'Scanning...';
            verifyBtn.style.opacity = '0.7';
            verifyBtn.style.cursor = 'wait';
            
            // Trigger visual feedback
            const circle = document.querySelector('.scan');
            if(circle) {
                circle.style.animationDuration = '0.5s'; // Speed up animation
            }

            setTimeout(() => {
                verifyBtn.textContent = 'Verified! ✅';
                verifyBtn.style.backgroundColor = '#10b981'; // Green
                verifyBtn.style.borderColor = '#10b981';
                verifyBtn.style.opacity = '1';
                verifyBtn.style.cursor = 'default';
                
                if(circle) {
                    circle.style.animationDuration = '2s'; // Reset
                }
                
                setTimeout(() => {
                    verifyBtn.textContent = originalText;
                    verifyBtn.style.backgroundColor = ''; // Reset to CSS
                    verifyBtn.style.borderColor = '';
                }, 3000);
            }, 1500);
        });
    }

    // Smooth scroll for anchors
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });
});
