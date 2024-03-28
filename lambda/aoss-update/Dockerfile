FROM public.ecr.aws/lambda/python:3.11

COPY requirements.txt requirements.txt

RUN yum update -y && pip3 install -r requirements.txt

COPY app.py app.py

CMD [ "app.lambda_handler"]
