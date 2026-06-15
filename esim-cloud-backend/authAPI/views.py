from rest_framework import generics, status, permissions
from rest_framework.response import Response
from django.conf import settings
from requests_oauthlib import OAuth2Session
from django.contrib.auth import get_user_model
from djoser.conf import settings as djoser_settings
from random import randint
from django.shortcuts import render
from django.http import HttpResponseNotFound
from djoser import utils
from djoser.serializers import TokenSerializer
from authAPI.serializers import TokenCreateSerializer

Token = djoser_settings.TOKEN_MODEL


def activate_user(request, uid, token):
    """
    Used to activate accounts,
    sends POST request to /api/auth/users/activation/ route
    internally to activate account.
    Link to this route is sent via email to user for verification
    """

    protocol = 'https://' if request.is_secure() else 'http://'
    web_url = protocol + request.get_host() + '/api/auth/users/activation/'  # noqa URL comes from Djoser library
    return render(request, 'activate_user.html',
                  {'uid': uid,
                   'token': token,
                   'activation_url': web_url,
                   'redirect_url': settings.POST_ACTIVATE_REDIRECT_URL
                   })


def GoogleOAuth2(request):
    state = request.GET.get('state', None)
    code = request.GET.get('code', None)

    if not (state is None) or not (code is None):
        client_id = settings.SOCIAL_AUTH_GOOGLE_OAUTH2_KEY
        client_secret = settings.SOCIAL_AUTH_GOOGLE_OAUTH2_SECRET

        google = OAuth2Session(
            client_id,
            redirect_uri=settings.GOOGLE_OAUTH_REDIRECT_URI,
            state=state
        )
        google.fetch_token(
            'https://accounts.google.com/o/oauth2/token',
            client_secret=client_secret,
            code=code
        )

        user_info = google.get(
            'https://www.googleapis.com/oauth2/v1/userinfo').json()

        if user_info['email']:
            user, created = get_user_model().objects.get_or_create(
                email=user_info['email'])
            if created:
                # If User was created
                # Set name to firstname_lastname1209
                username = user_info['name'].strip().replace(
                    ' ', '_') + str(randint(0, 9999))
                user.username = username
                user.save()
            token, created = Token.objects.get_or_create(user=user)

            protocol = 'https://' if request.is_secure() else 'http://'
            web_url = protocol + request.get_host() + '/eda/#/login'

            return render(request, 'google_callback.html',
                          {
                              "token": token,
                              "url": web_url
                          })
    return HttpResponseNotFound("<h1>Page Not Found</h1>")


class CustomTokenCreateView(utils.ActionViewMixin, generics.GenericAPIView):
    """
    Use this endpoint to obtain user authentication token.
    """

    serializer_class = TokenCreateSerializer
    permission_classes = [permissions.AllowAny]

    def _action(self, serializer):
        token = utils.login_user(self.request, serializer.user)
        token_serializer_class = TokenSerializer
        data = {
            'auth_token': token_serializer_class(token).data["auth_token"],
            'user_id': serializer.user.id
        }
        return Response(
            data=data, status=status.HTTP_200_OK
        )


class CustomUserCreateView(generics.GenericAPIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request, *args, **kwargs):
        username = request.data.get("username")
        email = request.data.get("email")
        password = request.data.get("password")

        # Basic validation
        errors = {}
        if not username:
            errors["username"] = ["This field is required."]
        if not email:
            errors["email"] = ["This field is required."]
        if not password:
            errors["password"] = ["This field is required."]

        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        # Check if username or email already exists in User
        User = get_user_model()
        if User.objects.filter(username=username).exists():
            errors["username"] = ["A user with that username already exists."]
        if User.objects.filter(email=email).exists():
            errors["email"] = ["A user with that email already exists."]

        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        # Encrypt password, generate OTP code, save PendingUser
        from django.contrib.auth.hashers import make_password
        import random
        from django.core.mail import send_mail
        from authAPI.models import PendingUser

        hashed_password = make_password(password)
        token = f"{random.randint(100000, 999999)}"

        # Clear existing pending entries for this email or username
        PendingUser.objects.filter(email=email).delete()
        PendingUser.objects.filter(username=username).delete()

        pending_user = PendingUser.objects.create(
            username=username,
            email=email,
            password=hashed_password,
            token=token
        )

        # Send activation email
        subject = "eSim Cloud Email Verification OTP"
        message = (
            f"Hello {username},\n\n"
            f"Thank you for registering at eSim Cloud.\n"
            f"Your verification OTP code is: {token}\n\n"
            f"Please enter this code on the registration page to verify your email and activate your account.\n\n"
            f"Best regards,\neSim Cloud Team"
        )
        from_email = settings.DEFAULT_FROM_EMAIL
        try:
            send_mail(subject, message, from_email, [email], fail_silently=False)
        except Exception as e:
            import logging
            logger = logging.getLogger(__name__)
            logger.warning(f"SMTP email sending failed: {str(e)}.")
            
            if settings.DEBUG:
                print("\n" + "="*80)
                print("EMAIL SENDING FAILED. FALLING BACK TO CONSOLE PRINT:")
                print(f"To: {email}")
                print(f"Subject: {subject}")
                print(message)
                print("="*80 + "\n")

        return Response({
            "username": username,
            "email": email,
            "id": pending_user.id
        }, status=status.HTTP_201_CREATED)


class CustomUserActivationView(generics.GenericAPIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request, *args, **kwargs):
        token = request.data.get("token")
        email = request.data.get("email")
        
        if not token:
            return Response({"token": ["This field is required."]}, status=status.HTTP_400_BAD_REQUEST)
        if not email:
            return Response({"email": ["This field is required."]}, status=status.HTTP_400_BAD_REQUEST)

        from authAPI.models import PendingUser
        try:
            pending_user = PendingUser.objects.get(token=token, email=email)
        except PendingUser.DoesNotExist:
            return Response({"token": ["Invalid OTP code."]}, status=status.HTTP_400_BAD_REQUEST)

        User = get_user_model()
        if User.objects.filter(username=pending_user.username).exists() or User.objects.filter(email=pending_user.email).exists():
            pending_user.delete()
            return Response({"detail": "User already registered."}, status=status.HTTP_400_BAD_REQUEST)

        User.objects.create(
            username=pending_user.username,
            email=pending_user.email,
            password=pending_user.password,
            is_active=True
        )

        pending_user.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)


def account_dashboard(request):
    from authAPI.models import PendingUser
    from django.contrib.auth import get_user_model
    User = get_user_model()

    if request.method == "POST":
        action = request.POST.get("action")
        user_id = request.POST.get("user_id")
        pending_id = request.POST.get("pending_id")

        if action == "delete_user" and user_id:
            User.objects.filter(id=user_id).delete()
        elif action == "delete_pending" and pending_id:
            PendingUser.objects.filter(id=pending_id).delete()
        elif action == "activate_pending" and pending_id:
            try:
                pending = PendingUser.objects.get(id=pending_id)
                # Check if username or email already exists in User to avoid IntegrityError
                if not User.objects.filter(username=pending.username).exists() and not User.objects.filter(email=pending.email).exists():
                    User.objects.create(
                        username=pending.username,
                        email=pending.email,
                        password=pending.password,
                        is_active=True
                    )
                pending.delete()
            except PendingUser.DoesNotExist:
                pass
        elif action == "create_user":
            username = request.POST.get("username")
            email = request.POST.get("email")
            password = request.POST.get("password")
            if username and email and password:
                from django.contrib.auth.hashers import make_password
                if not User.objects.filter(username=username).exists() and not User.objects.filter(email=email).exists():
                    User.objects.create(
                        username=username,
                        email=email,
                        password=make_password(password),
                        is_active=True
                    )

    # Fetch data
    users = User.objects.all().order_by("-date_joined")
    pending_users = PendingUser.objects.all().order_by("-created_at")

    return render(request, "account_dashboard.html", {
        "users": users,
        "pending_users": pending_users
    })
